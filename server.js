// server.js 파일 내용
require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const morgan = require('morgan');
const { Client, GatewayIntentBits } = require('discord.js'); //imports discord.js

const app = express();
const PORT = process.env.PORT || 3001;

const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent // Include if you need to read message content
    ]
});

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
});

client.login(process.env.CLIENT_TOKEN); //signs the bot in with token

// HTTP 요청 로깅 미들웨어
app.use(morgan('dev')); // 개발용: 간단한 로그
// app.use(morgan('combined')); // 프로덕션용: 상세한 로그

// CORS 설정 (개발 환경: 모든 origin 허용)
const corsOptions = {
    origin: true, // 모든 origin 허용 (개발용)
    // origin: ['http://localhost:3000', 'http://localhost:5173'], // 특정 origin만 허용하려면 이렇게 설정
    credentials: true, // 쿠키/인증 정보 허용
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'], // 허용할 HTTP 메서드
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'], // 허용할 헤더
    exposedHeaders: ['Content-Range', 'X-Content-Range'], // 클라이언트에 노출할 헤더
    maxAge: 86400 // preflight 요청 캐시 시간 (24시간)
};

app.use(cors(corsOptions));
// CORS 미들웨어가 이미 OPTIONS 요청을 자동으로 처리하므로 별도 설정 불필요

app.use(express.json());

// DB 연결 설정 (아까 .env 파일에 적은 정보를 자동으로 읽어옴)
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// DB 연결 테스트 함수
async function testConnection() {
    try {
        const connection = await pool.getConnection();
        console.log('✅ DB 연결 성공!');
        connection.release();
    } catch (error) {
        console.error('\n❌ DB 연결 오류 발생!\n');

        if (error.code === 'ER_ACCESS_DENIED_ERROR') {
            console.error('오류: Access denied for user');
            console.error('원인: .env 파일의 DB_PASSWORD가 틀렸습니다.');
            console.error('해결: .env 파일의 비밀번호를 다시 확인하고 node server.js를 재시작하세요.\n');
        } else if (error.code === 'ER_BAD_DB_ERROR') {
            console.error('오류: Unknown database');
            console.error('원인: CREATE DATABASE... SQL 코드가 실행되지 않았습니다.');
            console.error('해결: MySQL 터미널(mysql -u root -p)에 다시 접속해서 CREATE DATABASE secure_sbu;를 실행하세요.\n');
        } else if (error.code === 'ER_NO_SUCH_TABLE') {
            console.error('오류: Table does not exist');
            console.error('원인: CREATE TABLE reports... SQL 코드가 실행되지 않았습니다.');
            console.error('해결: MySQL 터미널에서 USE secure_sbu;를 먼저 실행한 뒤, CREATE TABLE reports... 코드를 다시 실행하세요.\n');
        } else {
            console.error('오류 상세:', error.message);
            console.error('오류 코드:', error.code);
        }
        process.exit(1);
    }
}

// (임시) 테스트를 위해 1번 사용자가 로그인했다고 가정합니다.
const FAKE_AUTH_USER_ID = 1;


/**
 * API 1: 내 리포트 목록 전부 가져오기
 * [GET] /api/reports
 */
app.get('/api/reports', async (req, res) => {
    const userId = FAKE_AUTH_USER_ID;

    // 쿼리 파라미터 (검색, 필터, 페이지)
    const { status, search } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10; // 기본값 10개, 쿼리 파라미터로 조정 가능
    const offset = (page - 1) * limit;

    let sql = `SELECT ticket_id, issue_type, title, description, status, created_at FROM reports WHERE submitted_by_user_id = ?`;
    let countSql = `SELECT COUNT(*) as total FROM reports WHERE submitted_by_user_id = ?`;

    const params = [userId];
    const countParams = [userId];

    // 1. 상태 필터
    if (status && ['Pending Review', 'In Progress', 'Resolved'].includes(status)) {
        sql += ` AND status = ?`;
        countSql += ` AND status = ?`;
        params.push(status);
        countParams.push(status);
    }

    // 2. 검색 필터
    if (search) {
        const searchTerm = `%${search}%`;
        sql += ` AND (ticket_id LIKE ? OR issue_type LIKE ? OR title LIKE ?)`;
        countSql += ` AND (ticket_id LIKE ? OR issue_type LIKE ? OR title LIKE ?)`;
        params.push(searchTerm, searchTerm, searchTerm);
        countParams.push(searchTerm, searchTerm, searchTerm);
    }

    // 3. 정렬 및 페이지네이션
    // LIMIT과 OFFSET은 파라미터화할 수 없으므로 직접 삽입 (SQL 인젝션 방지를 위해 숫자 검증)
    const safeLimit = parseInt(limit, 10);
    const safeOffset = parseInt(offset, 10);
    sql += ` ORDER BY created_at DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`;

    try {
        const connection = await pool.getConnection();

        // 디버깅: 쿼리와 파라미터 확인 (필요시 주석 해제)
        // console.log('SQL:', sql);
        // console.log('Params:', params);
        // console.log('Count SQL:', countSql);
        // console.log('Count Params:', countParams);

        // 총 개수
        const [countRows] = await connection.execute(countSql, countParams);
        const totalResults = countRows[0].total;
        const totalPages = Math.ceil(totalResults / limit);

        // 실제 데이터
        const [reports] = await connection.execute(sql, params);

        connection.release();

        // 응답 데이터 포맷팅 (프론트엔드 요구사항에 맞게)
        const formattedReports = reports.map(report => ({
            ticketId: report.ticket_id,
            IssueType: report.issue_type,
            title: report.title,
            description: report.description,
            status: report.status,
            dateSubmitted: report.created_at,
            createdAt: report.created_at,
            action: null // action 필드 (필요시 추가 가능)
        }));

        res.json({
            reports: formattedReports,
            pagination: {
                totalResults,
                totalPages,
                currentPage: page
            }
        });
    } catch (error) {
        console.error('Error fetching reports:', error);

        // 더 명확한 오류 메시지
        if (error.code === 'ER_ACCESS_DENIED_ERROR') {
            res.status(500).json({
                error: 'Database access denied',
                message: '.env 파일의 DB_PASSWORD를 확인하세요.'
            });
        } else if (error.code === 'ER_BAD_DB_ERROR') {
            res.status(500).json({
                error: 'Database not found',
                message: 'CREATE DATABASE secure_sbu;를 실행하세요.'
            });
        } else if (error.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({
                error: 'Table not found',
                message: 'CREATE TABLE reports...를 실행하세요.'
            });
        } else {
            res.status(500).json({ error: 'Server error', details: error.message });
        }
    }
});

/**
 * API 2: 새 리포트 제출
 * [POST] /api/reports
 */
app.post('/api/reports', async (req, res) => {
    const userId = FAKE_AUTH_USER_ID;

    // 요청 본문에서 데이터 추출
    const { issue_type, title, description } = req.body;

    // 필수 필드 검증
    if (!issue_type || !title || !description) {
        return res.status(400).json({
            error: 'Missing required fields',
            message: 'issue_type, title, and description are required'
        });
    }

    // issue_type 유효성 검증
    const validIssueTypes = [
        'phishing',
        'strange-login',
        'lost-device',
        'terror-threat'
    ];

    if (!validIssueTypes.includes(issue_type)) {
        return res.status(400).json({
            error: 'Invalid issue_type',
            message: `issue_type must be one of: ${validIssueTypes.join(', ')}`
        });
    }

    try {
        const connection = await pool.getConnection();

        // 1. 다음 ticket_id 생성 (가장 최근 ticket_id의 숫자 부분 + 1)
        let ticketId;
        try {
            // 모든 ticket_id를 가져와서 JavaScript에서 처리 (더 안정적)
            const [allTickets] = await connection.execute(
                `SELECT ticket_id FROM reports WHERE ticket_id LIKE 'SBU-%'`
            );

            if (allTickets.length > 0) {
                // 숫자 부분만 추출하여 최대값 찾기
                const numbers = allTickets
                    .map(t => parseInt(t.ticket_id.replace('SBU-', ''), 10))
                    .filter(n => !isNaN(n));

                if (numbers.length > 0) {
                    const maxNumber = Math.max(...numbers);
                    ticketId = `SBU-${maxNumber + 1}`;
                } else {
                    // 숫자 추출 실패 시 기본값
                    ticketId = `SBU-${84384 + allTickets.length + 1}`;
                }
            } else {
                // 첫 번째 리포트인 경우
                ticketId = 'SBU-84393'; // seed 데이터의 마지막 번호 다음
            }
        } catch (error) {
            // ticket_id 생성 실패 시 기본값 사용
            console.warn('Warning: Could not generate ticket_id, using fallback:', error.message);
            const [countRows] = await connection.execute('SELECT COUNT(*) as count FROM reports');
            const fallbackNumber = 84393 + (countRows[0].count || 0) + 1;
            ticketId = `SBU-${fallbackNumber}`;
        }

        // // 2. 리포트 삽입
        const status = 'Pending Review'; // 기본 상태
        const createdAt = new Date().toISOString().slice(0, 19).replace('T', ' ');

        await connection.execute(
            `INSERT INTO reports (
                ticket_id, 
                issue_type, 
                title,
                description,
                status, 
                submitted_by_user_id, 
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [ticketId, issue_type, title, description, status, userId, createdAt]
        );

        connection.release();

        if (DISCORD_CHANNEL_ID) {
            const channel = client.channels.cache.get(DISCORD_CHANNEL_ID);

            if (channel) {
                const message = `🚨 **New report ticket submitted!** 🚨\n\n` +
                    `**Ticket ID:** \`${ticketId}\`\n` +
                    `**Issue Type:** \`${issue_type}\`\n` +
                    `**Title:** **${title}**\n` +
                    `**Description:** ${description.substring(0, 50)}\n` +
                    `**Time:** ${createdAt}\n`;

                await channel.send(message);
                console.log(`✅ Discord 채널 ${DISCORD_CHANNEL_ID}에 알림 메시지 전송 완료.`);
            } else {
                console.warn(`❌ 경고: Discord 클라이언트가 채널 ID ${DISCORD_CHANNEL_ID}를 찾을 수 없습니다. (캐시 문제일 수 있음)`);
            }
        } else {
            console.warn('❌ 경고: DISCORD_CHANNEL_ID가 .env 파일에 설정되지 않았습니다. Discord 알림을 건너뜁니다.');
        }

        // 3. 생성된 리포트 반환
        res.status(201).json({
            message: 'Report submitted successfully',
            report: {
                ticket_id: ticketId,
                issue_type,
                title,
                description,
                status,
                created_at: createdAt
            }
        });

    } catch (error) {
        console.error('Error submitting report:', error);

        if (error.code === 'ER_DUP_ENTRY') {
            res.status(409).json({
                error: 'Duplicate entry',
                message: 'A report with this ticket_id already exists'
            });
        } else if (error.code === 'ER_NO_REFERENCED_ROW_2' || error.code === 'ER_NO_REFERENCED_ROW') {
            res.status(400).json({
                error: 'Invalid user',
                message: 'The user does not exist'
            });
        } else {
            res.status(500).json({
                error: 'Server error',
                details: error.message
            });
        }
    }
});

// ... (다른 API들: 상세 보기 등... 지금은 목록과 제출만!) ...


// 서버 시작
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`✅ 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
    console.log(`🌐 네트워크 접속: http://<로컬-IP주소>:${PORT}`);
    console.log(`   (같은 네트워크의 다른 기기에서 접속 가능)`);
    await testConnection();
});

