/**
 * 用户反馈服务 - Node.js 后端
 * 使用 SQLite 本地存储反馈数据
 */

// 加载环境变量
require('dotenv').config();

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ==================== 依赖检查 ====================
let sqlite3, multer;
try {
  sqlite3 = require('sqlite3').verbose();
} catch (e) {
  console.error('请先安装 sqlite3: npm install sqlite3');
  process.exit(1);
}

try {
  multer = require('multer');
} catch (e) {
  console.error('请先安装 multer: npm install multer');
  process.exit(1);
}

// ==================== 配置项 ====================
const CONFIG = {
  // 服务端口号
  PORT: parseInt(process.env.SERVER_PORT || '3001', 10),

  // 服务绑定地址
  HOST: process.env.HOST || 'localhost',

  // 管理后台工号白名单（逗号分隔）
  ADMIN_EMPLOYEE_NOS: (process.env.ADMIN_EMPLOYEE_NOS || '1223489').split(',').map(s => s.trim()),

  // 数据目录
  DATA_DIR: './data',
  UPLOAD_DIR: './data/uploads',

  // ===== toca 登录配置 =====
  TOCA_APP_KEY: 'cli_HTa80ODJzn9GJ2tVt',
  TOCA_APP_SECRET: '44hJy469uvNKjrUwwFG2rcRoERzB5cF4',
  TOCA_SPACE_ID: '0583d',

  TOCA_REDIRECT_URI: process.env.TOCA_REDIRECT_URI || 'http://localhost:3001/api/auth/callback',
  TOCA_AGENT_ID: 'H0DCwsLcUaveHq8uL3',

  TOCA_BASE_URL: 'http://toca.17u.cn',
  TOCA_APP_TOKEN_URL: 'http://toca.17u.cn/open-api/auth/app-token',
  TOCA_SPACE_TOKEN_URL: 'http://toca.17u.cn/open-api/auth/space-token',
  TOCA_OAUTH_AUTHORIZE_URL: 'http://toca.17u.cn/oauth/authorize',
  TOCA_GET_USER_BY_AUTH_CODE_URL: 'http://toca.17u.cn/open-api/oauth/getUserByAuthCode',
  TOCA_REFRESH_USER_TOKEN_URL: 'http://toca.17u.cn/open-api/auth/v2/user-token/refresh',

  // ===== toca IM 通知配置 =====
  TOCA_NOTIFY_USER_ID: '1223489',   // 接收通知的用户ID（工号或memberUniqueId）
  TOCA_NOTIFY_USER_TYPE: 2,          // 2=工号 4=memberUniqueId

  // ===== 管理后台地址 =====
  ADMIN_URL: process.env.ADMIN_URL || 'http://localhost:3001/admin.html',

  // ===== CORS 配置 =====
  CORS_ALLOWED_ORIGINS: (process.env.CORS_ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()),
};

// toca Token 缓存
const tocaTokens = {
  appToken: null,
  appTokenExpiresAt: 0,
  spaceToken: null,
  spaceTokenExpiresAt: 0,
};

// 用户 Session 存储
const userSessions = new Map();
const oauthStates = new Map();

// 请求限流记录
const rateLimitMap = new Map();

// ==================== 数据库初始化 ====================
const dbPath = path.join(CONFIG.DATA_DIR, 'feedback.db');
let db;

function initDatabase() {
  // 创建数据目录
  if (!fs.existsSync(CONFIG.DATA_DIR)) {
    fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(CONFIG.UPLOAD_DIR)) {
    fs.mkdirSync(CONFIG.UPLOAD_DIR, { recursive: true });
  }

  // 初始化数据库
  db = new sqlite3.Database(dbPath);

  db.run(`
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_type TEXT NOT NULL,
      description TEXT NOT NULL,
      contact TEXT,
      images TEXT,
      device_info TEXT,
      user_id TEXT,
      user_name TEXT DEFAULT '',
      department TEXT DEFAULT '',
      status TEXT DEFAULT '收集中',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 为旧数据添加新字段
  db.run(`ALTER TABLE feedback ADD COLUMN user_name TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE feedback ADD COLUMN status TEXT DEFAULT '收集中'`, () => {});
  db.run(`ALTER TABLE feedback ADD COLUMN space TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE feedback ADD COLUMN department TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE feedback ADD COLUMN position TEXT DEFAULT ''`, () => {});

  // 处理评论表
  db.run(`
    CREATE TABLE IF NOT EXISTS feedback_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feedback_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT DEFAULT '',
      type TEXT DEFAULT 'comment',
      content TEXT DEFAULT '',
      images TEXT DEFAULT '[]',
      status_snapshot TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (feedback_id) REFERENCES feedback(id)
    )
  `);

  // 为旧评论数据添加 type 字段
  db.run(`ALTER TABLE feedback_comments ADD COLUMN type TEXT DEFAULT 'comment'`, () => {});

  console.log(`[${formatDate()}] 数据库初始化完成: ${dbPath}`);
}

// ==================== Multer 配置 ====================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, CONFIG.UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, uniqueSuffix + ext);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 3 // 最多3张
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('只允许上传 jpg/png 图片'));
    }
  }
});

// ==================== 工具函数 ====================
function request(options, data = null) {
  return new Promise((resolve, reject) => {
    const client = options.protocol === 'https:' ? https : http;
    const req = client.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ status: res.statusCode, headers: res.headers, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, data: body });
        }
      });
    });

    req.on('error', reject);

    if (data) {
      req.write(typeof data === 'string' ? data : JSON.stringify(data));
    }

    req.end();
  });
}

function generateUUID() {
  return crypto.randomUUID();
}

function extractUserIdFromToken(token) {
  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
    return decoded.userId || '';
  } catch (e) {
    return '';
  }
}

function formatDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
         `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 根据请求 Origin 匹配 CORS 白名单
 */
function resolveCorsOrigins(req) {
  const origins = CONFIG.CORS_ALLOWED_ORIGINS;
  if (origins.includes('*')) return '*';
  const origin = req.headers.origin;
  if (origin && origins.includes(origin)) return origin;
  return origins[0] || '*';
}

function setCORS(res, allowedOrigin = '*') {
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res, message, statusCode = 500) {
  sendJSON(res, statusCode, { success: false, message });
}

function sendSuccess(res, data = {}) {
  sendJSON(res, 200, { success: true, ...data });
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

// 限流检查
function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000; // 1分钟
  const maxRequests = 5; // 最多5次

  const record = rateLimitMap.get(ip);
  if (!record) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + windowMs });
    return { allowed: true };
  }

  if (now > record.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + windowMs });
    return { allowed: true };
  }

  if (record.count >= maxRequests) {
    const retryAfter = Math.ceil((record.resetTime - now) / 1000);
    return { allowed: false, retryAfter };
  }

  record.count++;
  return { allowed: true };
}

// ==================== toca Token 管理 ====================
async function getTocaAppToken() {
  if (tocaTokens.appToken && tocaTokens.appTokenExpiresAt > Date.now() + 5 * 60 * 1000) {
    return tocaTokens.appToken;
  }

  const response = await request({
    method: 'POST',
    protocol: 'http:',
    hostname: 'toca.17u.cn',
    path: '/open-api/auth/app-token',
    headers: { 'Content-Type': 'application/json' }
  }, {
    appKey: CONFIG.TOCA_APP_KEY,
    appSecret: CONFIG.TOCA_APP_SECRET
  });

  if (!response.data.success) {
    throw new Error(`获取 toca appToken 失败: ${response.data.message}`);
  }

  const token = response.data.data?.accessToken || response.data.data?.token;
  tocaTokens.appToken = token;
  tocaTokens.appTokenExpiresAt = Date.now() + 7200 * 1000;
  return token;
}

async function getTocaSpaceToken() {
  if (tocaTokens.spaceToken && tocaTokens.spaceTokenExpiresAt > Date.now() + 5 * 60 * 1000) {
    return tocaTokens.spaceToken;
  }

  const response = await request({
    method: 'POST',
    protocol: 'http:',
    hostname: 'toca.17u.cn',
    path: '/open-api/auth/space-token',
    headers: { 'Content-Type': 'application/json' }
  }, {
    appKey: CONFIG.TOCA_APP_KEY,
    appSecret: CONFIG.TOCA_APP_SECRET,
    spaceId: CONFIG.TOCA_SPACE_ID
  });

  if (!response.data.success) {
    throw new Error(`获取 toca spaceToken 失败: ${response.data.message}`);
  }

  const spaceToken = response.data.data?.accessToken || response.data.data?.token;
  tocaTokens.spaceToken = spaceToken;
  tocaTokens.spaceTokenExpiresAt = Date.now() + 7200 * 1000;
  return spaceToken;
}

async function initTocaTokens() {
  try {
    await getTocaAppToken();
    await getTocaSpaceToken();
    console.log(`[${formatDate()}] toca Token 初始化完成`);
  } catch (error) {
    console.error(`[${formatDate()}] toca Token 初始化失败:`, error.message);
  }
}

// 每 110 分钟刷新 spaceToken
setInterval(async () => {
  try {
    await getTocaSpaceToken();
    console.log(`[${formatDate()}] toca spaceToken 自动刷新完成`);
  } catch (error) {
    console.error(`[${formatDate()}] toca spaceToken 自动刷新失败:`, error.message);
  }
}, 110 * 60 * 1000);

// 发送 toca IM 通知
async function sendTocaNotification({ issue_type, description, memberName, outerMemberId, employeeNo, space }) {
  if (!CONFIG.TOCA_NOTIFY_USER_ID) return;

  try {
    const spaceToken = await getTocaSpaceToken();

    const displayName = memberName || outerMemberId || '';
    // TODO: 待接入表单空间字段后替换
    const spaceName = space || '待确认';
    const desc = (description || '').length > 100
      ? (description || '').substring(0, 100) + '…'
      : (description || '');

    const cardContent = JSON.stringify({
      notify_title: '贴心 Claw 收到一条新用户反馈',
      ext_display: `${issue_type} - ${desc}`,
      conversation_display: `${issue_type} - ${desc}`,
      card: {
        customizeHeader: {
          title: {
            tag: 'lark_md',
            content: '贴心 Claw 新用户反馈通知'
          },
          type: 'default'
        },
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'plain_text',
              content: `反馈用户：${displayName}（${employeeNo}）`
            }
          },
          {
            tag: 'div',
            text: {
              tag: 'plain_text',
              content: `所属空间：${spaceName}`
            }
          },
          {
            tag: 'div',
            text: {
              tag: 'plain_text',
              content: `问题类型：${issue_type}`
            }
          },
          {
            tag: 'div',
            text: {
              tag: 'plain_text',
              content: `问题描述：${desc}`
            }
          },
          ...(CONFIG.ADMIN_URL ? [{
            tag: 'action',
            actions: [{
              tag: 'button',
              text: {
                tag: 'lark_md',
                content: '进入后台'
              },
              url: CONFIG.ADMIN_URL,
              type: 'default',
              destination: 'external',
              loading: true
            }]
          }] : [])
        ]
      }
    });

    const resp = await request({
      method: 'POST',
      hostname: 'toca.17u.cn',
      path: '/open-api/msg/v1/msg/bot/send',
      headers: {
        'Authorization': spaceToken,
        'Content-Type': 'application/json'
      }
    }, {
      requestId: Date.now(),
      to: CONFIG.TOCA_NOTIFY_USER_ID,
      msgType: 1,
      version: '1.0.0',
      content: cardContent,
      pushContent: '贴心 Claw 收到一条新用户反馈',
      userType: CONFIG.TOCA_NOTIFY_USER_TYPE
    });

    if (resp.data && resp.data.success) {
      console.log(`[${formatDate()}] toca IM 通知推送成功`);
    } else {
      console.error(`[${formatDate()}] toca IM 通知推送失败: code=${resp.data?.code}, message=${resp.data?.message}`);
    }
  } catch (e) {
    console.error(`[${formatDate()}] toca IM 通知推送异常:`, e.message);
  }
}

async function refreshTocaUserToken(refreshToken) {
  const response = await request({
    method: 'POST',
    protocol: 'http:',
    hostname: 'toca.17u.cn',
    path: '/open-api/auth/v2/user-token/refresh',
    headers: { 'Content-Type': 'application/json' }
  }, { refreshToken });

  if (!response.data.success) {
    throw new Error(`刷新 toca userToken 失败: ${response.data.message}`);
  }

  return response.data.data;
}

async function fetchMemberInfo(sessionId) {
  try {
    const session = userSessions.get(sessionId);
    if (!session || !session.tocaUserId) {
      console.log(`[${formatDate()}] 查询用户信息跳过: session 或 tocaUserId 不存在`);
      return { memberName: '', department: '', position: '' };
    }

    // 1. 用 appToken 调 uic/user 获取姓名
    const appToken = await getTocaAppToken();
    const resp = await request({
      method: 'GET',
      hostname: 'toca.17u.cn',
      path: `/open-api/uic/user?spaceId=${CONFIG.TOCA_SPACE_ID}&userId=${session.tocaUserId}`,
      headers: {
        'Authorization': appToken
      }
    });

    console.log(`[${formatDate()}] 查询用户信息返回: ${JSON.stringify(resp.data)}`);

    let memberName = '';
    if (resp.data && resp.data.success && resp.data.data) {
      memberName = resp.data.data.memberName || '';
      if (memberName) {
        session.memberName = memberName;
      }
    }

    // 2. 用 spaceToken 调 member/list-by-employee-nos 获取岗位信息
    let position = '';
    try {
      const spaceToken = await getTocaSpaceToken();
      const memberResp = await request({
        method: 'POST',
        hostname: 'toca.17u.cn',
        path: `/open-api/uic-apis/member/list-by-employee-nos`,
        headers: {
          'Authorization': spaceToken,
          'Content-Type': 'application/json'
        }
      }, {
        spaceId: CONFIG.TOCA_SPACE_ID,
        employeeNos: [session.employeeNo],
        includeCustomData: true
      });

      console.log(`[${formatDate()}] 岗位查询返回: ${JSON.stringify(memberResp.data)}`);

      if (memberResp.data && memberResp.data.success && memberResp.data.data?.length > 0) {
        const member = memberResp.data.data[0];

        // 岗位：从 customFields 中提取 post_level_name
        if (member.customFields?.length > 0) {
          const postField = member.customFields.find(f => f.name === 'post_level_name');
          if (postField) position = postField.value;
        }
      }
    } catch (e) {
      console.error(`[${formatDate()}] 岗位信息查询失败:`, e.message);
    }

    // 3. 部门：用 uic/user 返回的 departmentName（TOCA 中配置的末级部门名）
    let department = '';
    if (resp.data?.data?.departmentName) {
      department = resp.data.data.departmentName;
    }

    if (department) session.department = department;
    if (position) session.position = position;

    console.log(`[${formatDate()}] 查询用户信息成功: ${memberName}（${session.employeeNo}）部门: ${department}`);
    return { memberName, department, position };
  } catch (e) {
    console.error(`[${formatDate()}] 查询用户信息失败:`, e.message);
  }
  return { memberName: '', department: '', position: '' };
}

async function fetchMemberName(sessionId) {
  const result = await fetchMemberInfo(sessionId);
  return result.memberName;
}

async function checkAndRefreshUserToken(sessionId) {
  const session = userSessions.get(sessionId);
  if (!session) return null;

  const now = Date.now();
  const expireTime = session.accessTokenExpireInTimestamp * 1000;

  if (now > expireTime + 5 * 60 * 1000) {
    userSessions.delete(sessionId);
    return null;
  }

  if (now > expireTime - 10 * 60 * 1000) {
    try {
      const newTokenData = await refreshTocaUserToken(session.refreshToken);
      session.userAccessToken = newTokenData.userAccessToken;
      session.refreshToken = newTokenData.refreshToken;
      session.accessTokenExpireInTimestamp = newTokenData.accessTokenExpireInTimestamp * 1000;
    } catch (error) {
      if (now > expireTime) {
        userSessions.delete(sessionId);
        return null;
      }
    }
  }

  return session;
}

// ==================== 路由处理 ====================
async function serveStatic(req, res, filePath) {
  try {
    const fullPath = path.join(__dirname, filePath);
    const stats = await fs.promises.stat(fullPath);

    if (!stats.isFile()) {
      return false;
    }

    const content = await fs.promises.readFile(fullPath);
    const mimeType = getMimeType(fullPath);
    const headers = { 'Content-Type': mimeType };

    if (mimeType === 'text/html') {
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
    }

    res.writeHead(200, headers);
    res.end(content);
    return true;
  } catch (e) {
    return false;
  }
}

async function handleTocaLogin(req, res) {
  try {
    const state = generateUUID();
    const redirectUri = encodeURIComponent(CONFIG.TOCA_REDIRECT_URI);

    oauthStates.set(state, { createdAt: Date.now() });

    const now = Date.now();
    for (const [key, value] of oauthStates.entries()) {
      if (now - value.createdAt > 5 * 60 * 1000) {
        oauthStates.delete(key);
      }
    }

    const authUrl = `${CONFIG.TOCA_OAUTH_AUTHORIZE_URL}?agentId=${CONFIG.TOCA_AGENT_ID}&redirectUri=${redirectUri}&state=${state}`;

    console.log(`[${formatDate()}] 重定向到 toca 授权页面`);

    res.writeHead(302, { 'Location': authUrl });
    res.end();
  } catch (error) {
    console.error(`[${formatDate()}] 登录跳转错误:`, error.message);
    sendError(res, '登录跳转失败', 500);
  }
}

async function handleTocaCallback(req, res) {
  try {
    const query = url.parse(req.url, true).query;
    const code = query.code;
    const state = query.state;

    if (!state || !oauthStates.has(state)) {
      return renderErrorPage(res, '授权失败', '安全校验失败，请重新登录');
    }

    oauthStates.delete(state);

    if (!code) {
      return renderErrorPage(res, '授权失败', query.error || '授权失败');
    }

    const appToken = await getTocaAppToken();

    const response = await request({
      method: 'POST',
      protocol: 'http:',
      hostname: 'toca.17u.cn',
      path: '/open-api/oauth/getUserByAuthCode',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': appToken
      }
    }, { authCode: code });

    if (!response.data.success) {
      throw new Error(`获取用户信息失败: ${response.data.message}`);
    }

    const userData = response.data.data;
    const sessionId = generateUUID();

    console.log(`[${formatDate()}] toca 用户数据(完整): ${JSON.stringify(userData)}`);
    console.log(`[${formatDate()}] toca 用户数据字段: ${Object.keys(userData).join(', ')}`);
    console.log(`[${formatDate()}] userData.name=${userData.name}, userData.memberName=${userData.memberName}, userData.nickName=${userData.nickName}, userData.userName=${userData.userName}`);

    userSessions.set(sessionId, {
      openId: userData.openId,
      outerMemberId: userData.outerMemberId,
      employeeNo: userData.employeeNo,
      tocaUserId: extractUserIdFromToken(userData.userAccessToken),
      name: userData.name || userData.memberName || userData.nickName || userData.userName || '',
      memberName: '',
      userAccessToken: userData.userAccessToken,
      refreshToken: userData.refreshToken,
      accessTokenExpireInTimestamp: userData.accessTokenExpireInTimestamp * 1000,
      loginTime: Date.now()
    });

    // 异步查询用户姓名，写入 session
    fetchMemberName(sessionId);

    console.log(`[${formatDate()}] 用户登录成功: ${userData.name || ''} ${userData.employeeNo || userData.openId}`);

    const isHttps = CONFIG.HOST !== 'localhost' && !CONFIG.HOST.includes('127.0.0.1') && process.env.NODE_ENV === 'production';
    const cookieOptions = isHttps
      ? `sessionId=${sessionId}; HttpOnly; Path=/; Max-Age=1296000; SameSite=None; Secure`
      : `sessionId=${sessionId}; HttpOnly; Path=/; Max-Age=1296000; SameSite=Lax`;

    res.writeHead(302, {
      'Location': '/',
      'Set-Cookie': cookieOptions
    });
    res.end();

  } catch (error) {
    console.error(`[${formatDate()}] OAuth 回调错误:`, error.message);
    renderErrorPage(res, '授权出错', error.message);
  }
}

// ==================== 管理后台 TOCA 登录 ====================
async function handleAdminTocaLogin(req, res) {
  try {
    const state = generateUUID();
    oauthStates.set(state, { createdAt: Date.now() });

    const isProd = CONFIG.HOST !== 'localhost' && !CONFIG.HOST.includes('127.0.0.1');
    const callbackBase = isProd ? CONFIG.ADMIN_URL.replace('/admin.html', '') : `http://localhost:3001`;
    const redirectUri = `${callbackBase}/api/admin/auth/callback`;
    const authUrl = `${CONFIG.TOCA_OAUTH_AUTHORIZE_URL}?agentId=${CONFIG.TOCA_AGENT_ID}&redirectUri=${encodeURIComponent(redirectUri)}&state=${state}`;

    res.writeHead(302, { 'Location': authUrl });
    res.end();
  } catch (error) {
    sendError(res, '登录跳转失败', 500);
  }
}

// 管理后台专用：创建 session 并检查工号白名单
async function handleAdminTocaCallback(req, res) {
  try {
    const query = url.parse(req.url, true).query;
    const code = query.code;
    const state = query.state;

    if (!code) {
      return renderErrorPage(res, '授权失败', query.error || '授权失败');
    }

    const appToken = await getTocaAppToken();
    const response = await request({
      method: 'POST',
      protocol: 'http:',
      hostname: 'toca.17u.cn',
      path: '/open-api/oauth/getUserByAuthCode',
      headers: { 'Content-Type': 'application/json', 'Authorization': appToken }
    }, { authCode: code });

    if (!response.data.success) {
      return renderErrorPage(res, '获取用户信息失败', response.data.message);
    }

    const userData = response.data.data;
    const employeeNo = userData.employeeNo;

    // 检查工号白名单
    if (!CONFIG.ADMIN_EMPLOYEE_NOS.includes(employeeNo)) {
      return renderErrorPage(res, '无管理权限', `工号 ${employeeNo} 未被授权为管理员，请联系系统管理员配置`);
    }

    const sessionId = generateUUID();
    userSessions.set(sessionId, {
      openId: userData.openId,
      outerMemberId: userData.outerMemberId,
      employeeNo: userData.employeeNo,
      tocaUserId: extractUserIdFromToken(userData.userAccessToken),
      name: userData.name || userData.memberName || userData.nickName || userData.userName || '',
      memberName: '',
      userAccessToken: userData.userAccessToken,
      refreshToken: userData.refreshToken,
      accessTokenExpireInTimestamp: userData.accessTokenExpireInTimestamp * 1000,
      loginTime: Date.now(),
      isAdmin: true
    });

    fetchMemberName(sessionId);

    console.log(`[${formatDate()}] 管理员登录成功: ${userData.name || ''} (${employeeNo})`);

    const isHttps = CONFIG.HOST !== 'localhost' && !CONFIG.HOST.includes('127.0.0.1') && process.env.NODE_ENV === 'production';
    const cookieOptions = isHttps
      ? `adminSessionId=${sessionId}; HttpOnly; Path=/; Max-Age=1296000; SameSite=None; Secure`
      : `adminSessionId=${sessionId}; HttpOnly; Path=/; Max-Age=1296000; SameSite=Lax`;

    res.writeHead(302, {
      'Location': '/admin.html',
      'Set-Cookie': cookieOptions
    });
    res.end();
  } catch (error) {
    console.error(`[${formatDate()}] 管理员 OAuth 回调错误:`, error.message);
    renderErrorPage(res, '授权出错', error.message);
  }
}

// 管理后台权限检查中间件
function checkAdminAuth(req, res) {
  const cookie = req.headers.cookie;
  if (!cookie) return null;

  const cookies = cookie.split(';').reduce((acc, c) => {
    const [key, value] = c.trim().split('=');
    acc[key] = value;
    return acc;
  }, {});

  const sessionId = cookies.adminSessionId;
  if (!sessionId) return null;

  const session = userSessions.get(sessionId);
  if (!session || !session.isAdmin) return null;

  return session;
}

// 管理后台退出
function handleAdminLogout(req, res) {
  const cookie = req.headers.cookie;
  if (cookie) {
    const cookies = cookie.split(';').reduce((acc, c) => {
      const [key, value] = c.trim().split('=');
      acc[key] = value;
      return acc;
    }, {});
    if (cookies.adminSessionId) {
      userSessions.delete(cookies.adminSessionId);
    }
  }
  const clearCookie = 'adminSessionId=; HttpOnly; Path=/; Max-Age=0';
  res.writeHead(302, {
    'Location': '/admin.html',
    'Set-Cookie': clearCookie
  });
  res.end();
}

function renderErrorPage(res, title, message) {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title}</title>
      <style>
        body { font-family: -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
        .container { text-align: center; background: #fff; padding: 40px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
        .icon { font-size: 48px; margin-bottom: 16px; }
        h2 { margin: 0 0 8px; color: #333; }
        p { color: #666; margin: 0 0 20px; }
        .btn { display: inline-block; padding: 12px 24px; background: #1677ff; color: #fff; text-decoration: none; border-radius: 8px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="icon">❌</div>
        <h2>${title}</h2>
        <p>${message}</p>
        <a href="/" class="btn">返回重试</a>
      </div>
    </body>
    </html>
  `);
}

function handleLogout(req, res) {
  try {
    const cookie = req.headers.cookie;
    if (cookie) {
      const cookies = cookie.split(';').reduce((acc, c) => {
        const [key, value] = c.trim().split('=');
        acc[key] = value;
        return acc;
      }, {});

      const sessionId = cookies.sessionId;
      if (sessionId) {
        userSessions.delete(sessionId);
        console.log(`[${formatDate()}] 用户退出登录: ${sessionId}`);
      }
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'sessionId=; HttpOnly; Path=/; Max-Age=0'
    });
    res.end(JSON.stringify({ success: true, message: '退出成功' }));
  } catch (error) {
    sendError(res, '退出登录失败');
  }
}

async function handleGetUserInfo(req, res) {
  try {
    const cookie = req.headers.cookie;
    if (!cookie) {
      return sendSuccess(res, { loggedIn: false });
    }

    const cookies = cookie.split(';').reduce((acc, c) => {
      const [key, value] = c.trim().split('=');
      acc[key] = value;
      return acc;
    }, {});

    const sessionId = cookies.sessionId;
    if (!sessionId) {
      return sendSuccess(res, { loggedIn: false });
    }

    const session = await checkAndRefreshUserToken(sessionId);
    if (!session) {
      return sendSuccess(res, { loggedIn: false });
    }

    sendSuccess(res, {
      loggedIn: true,
      openId: session.openId,
      employeeNo: session.employeeNo,
      outerMemberId: session.outerMemberId,
      name: session.name || '',
      department: session.department || '',
      position: session.position || ''
    });

  } catch (error) {
    sendError(res, '获取用户信息失败');
  }
}

// ==================== 反馈提交接口 ====================
async function handleSubmit(req, res) {
  // 获取客户端 IP
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  // 限流检查
  const rateLimit = checkRateLimit(clientIp);
  if (!rateLimit.allowed) {
    return sendError(res, `请求过于频繁，请 ${rateLimit.retryAfter} 秒后重试`, 429);
  }

  // 检查登录状态
  const cookie = req.headers.cookie;
  if (!cookie) {
    return sendError(res, '请先登录', 401);
  }

  const cookies = cookie.split(';').reduce((acc, c) => {
    const [key, value] = c.trim().split('=');
    acc[key] = value;
    return acc;
  }, {});

  const sessionId = cookies.sessionId;
  if (!sessionId || !userSessions.has(sessionId)) {
    return sendError(res, '请先登录', 401);
  }

  const session = userSessions.get(sessionId);

  // 使用 multer 处理文件上传
  upload.array('images', 3)(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return sendError(res, '单张图片不能超过 10MB', 400);
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return sendError(res, '最多上传 3 张图片', 400);
        }
      }
      return sendError(res, err.message || '文件上传失败', 400);
    }

    const { issue_type, description, contact, device_info, space } = req.body;

    // 参数校验
    if (!issue_type || !description) {
      // 删除已上传的文件
      if (req.files) {
        req.files.forEach(file => {
          fs.unlink(file.path, () => {});
        });
      }
      return sendError(res, '问题类型和描述不能为空', 400);
    }

    // 收集图片路径
    const imagePaths = req.files ? req.files.map(f => f.filename) : [];

    // 如果 session 中没有姓名，同步查询一次
    if (!session.memberName) {
      await fetchMemberInfo(cookies.sessionId);
    }

    // 使用 session 中的部门和岗位信息
    let department = session.department || '';
    let position = session.position || '';

    // 写入数据库：优先 memberName > outerMemberId > employeeNo
    const userName = session.memberName
      ? (session.employeeNo ? `${session.memberName}（${session.employeeNo}）` : session.memberName)
      : session.outerMemberId
        ? (session.employeeNo ? `${session.outerMemberId}（${session.employeeNo}）` : session.outerMemberId)
        : (session.employeeNo || '');

    db.run(
      `INSERT INTO feedback (issue_type, description, contact, images, device_info, user_id, user_name, department, position, space)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [issue_type, description, contact || '', JSON.stringify(imagePaths), device_info || '', session.openId, userName, department, position, space || ''],
      function(err) {
        if (err) {
          console.error(`[${formatDate()}] 数据库写入失败:`, err);
          // 删除已上传的文件
          if (req.files) {
            req.files.forEach(file => {
              fs.unlink(file.path, () => {});
            });
          }
          return sendError(res, '提交失败，请重试');
        }

        console.log(`[${formatDate()}] 反馈提交成功: id=${this.lastID}, type=${issue_type}`);

        // 异步推送 toca IM 通知
        sendTocaNotification({
          issue_type,
          description,
          memberName: session.memberName,
          outerMemberId: session.outerMemberId,
          employeeNo: session.employeeNo,
          space: space || ''
        });

        sendSuccess(res, { id: this.lastID, message: '提交成功' });
      }
    );
  });
}

// ==================== 查询接口 ====================
function handleList(req, res) {
  const session = checkAdminAuth(req, res);
  if (!session) return sendError(res, '未授权，请先登录', 401);

  const parsedUrl = url.parse(req.url, true);
  const query = parsedUrl.query;

  const issueType = query.issue_type;
  const status = query.status;
  const space = query.space;
  const keyword = query.keyword;
  const startDate = query.start_date;
  const endDate = query.end_date;
  const page = parseInt(query.page) || 1;
  const pageSize = Math.min(parseInt(query.page_size) || 15, 100);
  const offset = (page - 1) * pageSize;

  // 构建查询条件
  let conditions = [];
  let countParams = [];
  let queryParams = [];

  if (issueType && issueType !== 'all') {
    conditions.push('issue_type = ?');
    countParams.push(issueType);
    queryParams.push(issueType);
  }

  if (status && status !== 'all') {
    conditions.push('status = ?');
    countParams.push(status);
    queryParams.push(status);
  }

  if (space && space !== 'all') {
    conditions.push('space = ?');
    countParams.push(space);
    queryParams.push(space);
  }

  if (keyword && keyword.trim()) {
    conditions.push('(description LIKE ? OR user_name LIKE ?)');
    countParams.push(`%${keyword.trim()}%`, `%${keyword.trim()}%`);
    queryParams.push(`%${keyword.trim()}%`, `%${keyword.trim()}%`);
  }

  if (startDate) {
    conditions.push('created_at >= ?');
    countParams.push(startDate + ' 00:00:00');
    queryParams.push(startDate + ' 00:00:00');
  }

  if (endDate) {
    conditions.push('created_at <= ?');
    countParams.push(endDate + ' 23:59:59');
    queryParams.push(endDate + ' 23:59:59');
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // 查询总数
  const countSql = `SELECT COUNT(*) as total FROM feedback ${whereClause}`;

  db.get(countSql, countParams, (err, countRow) => {
    if (err) {
      console.error(`[${formatDate()}] 查询总数失败:`, err);
      return sendError(res, '查询失败');
    }

    const total = countRow.total;

    // 查询列表
    const listSql = `SELECT * FROM feedback ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    queryParams.push(pageSize, offset);

    db.all(listSql, queryParams, (err, rows) => {
      if (err) {
        console.error(`[${formatDate()}] 查询列表失败:`, err);
        return sendError(res, '查询失败');
      }

      // 处理图片路径
      const formattedRows = rows.map(row => ({
        ...row,
        images: row.images ? JSON.parse(row.images) : []
      }));

      sendSuccess(res, {
        list: formattedRows,
        total,
        page,
        page_size: pageSize,
        total_pages: Math.ceil(total / pageSize)
      });
    });
  });
}

// ==================== 统计接口 ====================
function handleStats(req, res) {
  const session = checkAdminAuth(req, res);
  if (!session) return sendError(res, '未授权，请先登录', 401);

  db.all(
    `SELECT issue_type, COUNT(*) as count FROM feedback GROUP BY issue_type`,
    (err, rows) => {
      if (err) {
        console.error(`[${formatDate()}] 统计查询失败:`, err);
        return sendError(res, '查询失败');
      }

      const stats = {
        total: 0,
        by_type: {}
      };

      rows.forEach(row => {
        stats.by_type[row.issue_type] = row.count;
        stats.total += row.count;
      });

      // 按状态统计
      db.all(
        `SELECT status, COUNT(*) as count FROM feedback GROUP BY status`,
        (err2, statusRows) => {
          if (!err2) {
            stats.by_status = {};
            statusRows.forEach(row => {
              stats.by_status[row.status] = row.count;
            });
          }
          sendSuccess(res, stats);
        }
      );
    }
  );
}

// ==================== 数据概览接口 ====================
function handleOverview(req, res) {
  const session = checkAdminAuth(req, res);
  if (!session) return sendError(res, '未授权，请先登录', 401);

  const now = new Date();
  const dayOfWeek = now.getDay() || 7; // 1=周一, 7=周日
  const thisWeekStart = new Date(now);
  thisWeekStart.setDate(now.getDate() - dayOfWeek + 1);
  thisWeekStart.setHours(0, 0, 0, 0);
  const thisWeekStartStr = thisWeekStart.toISOString().slice(0, 10);

  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const lastWeekStartStr = lastWeekStart.toISOString().slice(0, 10);

  db.get(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN date(created_at) >= ? THEN 1 ELSE 0 END) as total_tw,
       SUM(CASE WHEN date(created_at) >= ? AND date(created_at) < ? THEN 1 ELSE 0 END) as total_lw,
       SUM(CASE WHEN date(created_at) >= ? AND status = '收集中' THEN 1 ELSE 0 END) as pending_tw,
       SUM(CASE WHEN date(created_at) >= ? AND date(created_at) < ? AND status = '收集中' THEN 1 ELSE 0 END) as pending_lw,
       SUM(CASE WHEN date(created_at) >= ? AND status = '已解决' THEN 1 ELSE 0 END) as resolved_tw,
       SUM(CASE WHEN date(created_at) >= ? AND date(created_at) < ? AND status = '已解决' THEN 1 ELSE 0 END) as resolved_lw
     FROM feedback`,
    [thisWeekStartStr, lastWeekStartStr, thisWeekStartStr, thisWeekStartStr, lastWeekStartStr, thisWeekStartStr, thisWeekStartStr, lastWeekStartStr, thisWeekStartStr],
    (err, row) => {
      if (err) {
        console.error(`[${formatDate()}] 概览查询失败:`, err);
        return sendError(res, '查询失败');
      }

      const total = row.total || 0;
      const totalTw = row.total_tw || 0;
      const totalLw = row.total_lw || 0;
      const pendingTw = row.pending_tw || 0;
      const pendingLw = row.pending_lw || 0;
      const resolvedTw = row.resolved_tw || 0;
      const resolvedLw = row.resolved_lw || 0;

      const newCountTw = totalTw; // 本周新增 = 本周创建的总数
      const newCountLw = totalLw; // 上周7天新增
      const dailyAvg = (newCountLw / 7).toFixed(1); // 上周日均

      sendSuccess(res, {
        total: {
          value: total,
          delta: totalTw - totalLw
        },
        new_count: {
          value: newCountTw,
          delta: newCountTw - newCountLw,
          daily_avg: dailyAvg
        },
        pending: {
          value: pendingTw,
          delta: pendingTw - pendingLw
        },
        resolved: {
          value: resolvedTw,
          delta: resolvedTw - resolvedLw
        }
      });
    }
  );
}

// ==================== 周趋势接口 ====================
function handleWeeklyTrend(req, res) {
  const session = checkAdminAuth(req, res);
  if (!session) return sendError(res, '未授权，请先登录', 401);

  const now = new Date();
  const dayOfWeek = now.getDay() || 7;
  const thisWeekStart = new Date(now);
  thisWeekStart.setDate(now.getDate() - dayOfWeek + 1);
  thisWeekStart.setHours(0, 0, 0, 0);

  // 过去4周共28天
  const startDate = new Date(thisWeekStart);
  startDate.setDate(startDate.getDate() - 27);
  const startDateStr = startDate.toISOString().slice(0, 10);
  const endDateStr = now.toISOString().slice(0, 10);

  // 生成28天的日期列表
  const days = [];
  for (let i = 0; i < 28; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    days.push(d.toISOString().slice(0, 10));
  }

  db.all(
    `SELECT date(created_at) as day,
            COUNT(*) as new_count,
            SUM(CASE WHEN status = '收集中' THEN 1 ELSE 0 END) as pending,
            SUM(CASE WHEN status = '已解决' THEN 1 ELSE 0 END) as resolved
     FROM feedback
     WHERE date(created_at) >= ? AND date(created_at) <= ?
     GROUP BY day
     ORDER BY day`,
    [startDateStr, endDateStr],
    (err, rows) => {
      if (err) {
        console.error(`[${formatDate()}] 趋势查询失败:`, err);
        return sendError(res, '查询失败');
      }

      // 按天聚合
      const byDay = {};
      rows.forEach(r => { byDay[r.day] = r; });

      const trend = days.map(day => ({
        date: day,
        new_count: byDay[day]?.new_count || 0,
        pending: byDay[day]?.pending || 0,
        resolved: byDay[day]?.resolved || 0
      }));

      sendSuccess(res, { trend });
    }
  );
}

// ==================== 评论接口 ====================
// GET /api/feedbacks/:id/comments
function handleGetComments(req, res) {
  const session = checkAdminAuth(req, res);
  if (!session) return sendError(res, '未授权，请先登录', 401);

  const parsedUrl = url.parse(req.url, true);
  const segments = parsedUrl.pathname.split('/');
  const feedbackId = segments[segments.length - 2];

  db.all(
    `SELECT * FROM feedback_comments WHERE feedback_id = ? ORDER BY created_at ASC`,
    [feedbackId],
    (err, rows) => {
      if (err) {
        console.error(`[${formatDate()}] 查询评论失败:`, err);
        return sendError(res, '查询失败');
      }
      sendSuccess(res, { comments: rows || [] });
    }
  );
}

// POST /api/feedbacks/:id/comments
function handleCreateComment(req, res) {
  const session = checkAdminAuth(req, res);
  if (!session) return sendError(res, '未授权，请先登录', 401);

  const parsedUrl = url.parse(req.url, true);
  const segments = parsedUrl.pathname.split('/');
  const feedbackId = segments[segments.length - 2];

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    let data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      return sendError(res, '请求格式错误', 400);
    }

    const content = (data.content || '').trim();
    const images = data.images || [];
    const statusSnapshot = data.status_snapshot || '';
    const userName = data.user_name || '管理员';

    if (!content && images.length === 0) {
      return sendError(res, '备注内容不能为空', 400);
    }

    db.run(
      `INSERT INTO feedback_comments (feedback_id, user_id, user_name, content, images, status_snapshot)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [feedbackId, 'admin', userName, content, JSON.stringify(images), statusSnapshot],
      function(err) {
        if (err) {
          console.error(`[${formatDate()}] 写入评论失败:`, err);
          return sendError(res, '提交失败');
        }
        sendSuccess(res, { id: this.lastID });
      }
    );
  });
}

// 评论图片上传
function handleCommentImageUpload(req, res) {
  const session = checkAdminAuth(req, res);
  if (!session) return sendError(res, '未授权，请先登录', 401);

  const upload = multer({
    storage: multer.diskStorage({
      destination: (r, f, cb) => cb(null, CONFIG.UPLOAD_DIR),
      filename: (r, f, cb) => {
        const ext = path.extname(f.originalname).toLowerCase() || '.png';
        cb(null, 'comment_' + Date.now() + '-' + Math.round(Math.random() * 1E9) + ext);
      }
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (r, f, cb) => {
      if (['image/jpeg', 'image/png', 'image/jpg'].includes(f.mimetype)) cb(null, true);
      else cb(new Error('只允许 jpg/png 图片'));
    }
  }).single('image');

  upload(req, res, (err) => {
    if (err) return sendError(res, err.message, 400);
    if (!req.file) return sendError(res, '未上传文件', 400);
    sendSuccess(res, { filename: req.file.filename });
  });
}

// ==================== 导出接口 ====================
function handleExport(req, res) {
  const session = checkAdminAuth(req, res);
  if (!session) return sendError(res, '未授权，请先登录', 401);

  const parsedUrl = url.parse(req.url, true);
  const query = parsedUrl.query;
  const issueType = query.issue_type;
  const status = query.status;
  const space = query.space;
  const startDate = query.start_date;
  const endDate = query.end_date;

  // 构建查询条件
  let conditions = [];
  let queryParams = [];

  if (issueType && issueType !== 'all') {
    conditions.push('issue_type = ?');
    queryParams.push(issueType);
  }

  if (status && status !== 'all') {
    conditions.push('status = ?');
    queryParams.push(status);
  }

  if (space && space !== 'all') {
    conditions.push('space = ?');
    queryParams.push(space);
  }

  if (startDate) {
    conditions.push('created_at >= ?');
    queryParams.push(startDate + ' 00:00:00');
  }

  if (endDate) {
    conditions.push('created_at <= ?');
    queryParams.push(endDate + ' 23:59:59');
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // 查询所有数据（不分页）
  const sql = `SELECT * FROM feedback ${whereClause} ORDER BY created_at DESC`;

  db.all(sql, queryParams, (err, rows) => {
    if (err) {
      console.error(`[${formatDate()}] 导出查询失败:`, err);
      return sendError(res, '导出失败');
    }

    // 生成 CSV 内容
    const headers = ['ID', '问题类型', '问题描述', '联系方式', '提交人', '所属部门', '所属空间', '当前状态', '图片链接', '设备信息', '提交时间'];
    let csvContent = headers.join(',') + '\n';

    rows.forEach(row => {
      const images = row.images ? JSON.parse(row.images).map(img => `${req.headers.host}/data/uploads/${img}`).join('; ') : '';
      const values = [
        row.id,
        escapeCsv(row.issue_type),
        escapeCsv(row.description),
        escapeCsv(row.contact || ''),
        escapeCsv(row.user_name || ''),
        escapeCsv(row.department || ''),
        escapeCsv(row.space || ''),
        escapeCsv(row.status || '收集中'),
        escapeCsv(images),
        escapeCsv(row.device_info || ''),
        row.created_at
      ];
      csvContent += values.join(',') + '\n';
    });

    // 添加 BOM 以支持中文
    const bom = '\uFEFF';
    const buffer = Buffer.from(bom + csvContent, 'utf-8');

    // 生成文件名
    const timestamp = formatDate().replace(/[:\s]/g, '_');
    const filename = `feedback_export_${timestamp}.csv`;

    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length
    });
    res.end(buffer);

    console.log(`[${formatDate()}] 导出成功: ${filename}, 共 ${rows.length} 条记录`);
  });
}

// CSV 字段转义
function escapeCsv(value) {
  if (value == null) return '';
  const str = String(value);
  // 如果包含逗号、引号或换行符，需要用引号包裹并转义
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// ==================== 状态更新接口 ====================
function handleUpdateStatus(req, res) {
  const session = checkAdminAuth(req, res);
  if (!session) return sendError(res, '未授权，请先登录', 401);

  // 读取请求体
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const { id, status } = data;

      if (!id || !status) {
        return sendError(res, '参数缺失', 400);
      }

      const validStatuses = ['收集中', '解决中', '已解决'];
      if (!validStatuses.includes(status)) {
        return sendError(res, '无效的状态值', 400);
      }

      // 先查询当前状态
      db.get('SELECT status FROM feedback WHERE id = ?', [id], (err, row) => {
        if (err) {
          console.error(`[${formatDate()}] 查询当前状态失败:`, err);
          return sendError(res, '更新失败');
        }
        if (!row) {
          return sendError(res, '记录不存在', 404);
        }

        const oldStatus = row.status;
        if (oldStatus === status) {
          return sendSuccess(res, { message: '状态未变更' });
        }

        db.run(
          'UPDATE feedback SET status = ? WHERE id = ?',
          [status, id],
          function(err) {
            if (err) {
              console.error(`[${formatDate()}] 状态更新失败:`, err);
              return sendError(res, '更新失败');
            }

            // 自动记录状态变更到 comments 表
            db.run(
              `INSERT INTO feedback_comments (feedback_id, user_id, user_name, type, content, status_snapshot)
               VALUES (?, ?, ?, 'status_change', '', ?)`,
              [id, 'admin', '管理员', JSON.stringify({ from: oldStatus, to: status })],
              (err) => {
                if (err) {
                  console.error(`[${formatDate()}] 记录状态变更失败:`, err);
                }
              }
            );

            sendSuccess(res, { message: '状态更新成功' });
          }
        );
      });
    } catch (e) {
      sendError(res, '请求格式错误', 400);
    }
  });
}

// ==================== 主服务器 ====================
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  setCORS(res, resolveCorsOrigins(req));

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // 登录相关路由
    if (pathname === '/api/auth/login' && req.method === 'GET') {
      return await handleTocaLogin(req, res);
    }

    if (pathname === '/api/auth/callback' && req.method === 'GET') {
      return await handleTocaCallback(req, res);
    }

    if (pathname === '/api/auth/logout' && req.method === 'GET') {
      return handleLogout(req, res);
    }

    // 管理后台 TOCA 登录
    if (pathname === '/api/admin/auth/login' && req.method === 'GET') {
      return await handleAdminTocaLogin(req, res);
    }

    if (pathname === '/api/admin/auth/callback' && req.method === 'GET') {
      return await handleAdminTocaCallback(req, res);
    }

    if (pathname === '/api/admin/auth/logout' && req.method === 'GET') {
      return handleAdminLogout(req, res);
    }

    if (pathname === '/api/user/info' && req.method === 'GET') {
      return await handleGetUserInfo(req, res);
    }

    // 反馈提交接口
    if (pathname === '/api/feedback/submit' && req.method === 'POST') {
      return handleSubmit(req, res);
    }

    // 查询接口
    if (pathname === '/api/feedback/list' && req.method === 'GET') {
      return handleList(req, res);
    }

    // 统计接口
    if (pathname === '/api/feedback/stats' && req.method === 'GET') {
      return handleStats(req, res);
    }

    // 数据概览接口
    if (pathname === '/api/stats/overview' && req.method === 'GET') {
      return handleOverview(req, res);
    }

    // 周趋势接口
    if (pathname === '/api/stats/weekly-trend' && req.method === 'GET') {
      return handleWeeklyTrend(req, res);
    }

    // 导出接口
    if (pathname === '/api/feedback/export' && req.method === 'GET') {
      return handleExport(req, res);
    }

    // 状态更新接口
    if (pathname === '/api/feedback/update-status' && req.method === 'POST') {
      return handleUpdateStatus(req, res);
    }

    // 评论图片上传接口
    if (pathname === '/api/upload-comment-image' && req.method === 'POST') {
      return handleCommentImageUpload(req, res);
    }

    // 评论接口
    if (pathname.startsWith('/api/feedbacks/') && pathname.endsWith('/comments')) {
      if (req.method === 'GET') return handleGetComments(req, res);
      if (req.method === 'POST') return handleCreateComment(req, res);
    }

    // 图片访问路由
    if (pathname.startsWith('/data/uploads/') && req.method === 'GET') {
      const filename = path.basename(pathname);
      const imagePath = path.join(CONFIG.UPLOAD_DIR, filename);
      try {
        const content = await fs.promises.readFile(imagePath);
        const ext = path.extname(imagePath).toLowerCase();
        const mimeTypes = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif'
        };
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'image/png' });
        res.end(content);
        return;
      } catch (e) {
        return sendError(res, '图片不存在', 404);
      }
    }

    // 健康检查
    if (pathname === '/api/health') {
      return sendSuccess(res, { status: 'ok', time: formatDate() });
    }

    // 静态文件服务
    let staticPath = pathname;
    if (pathname === '/' || pathname === '/index') {
      staticPath = '/index.html';
    }

    const served = await serveStatic(req, res, staticPath);
    if (served) {
      return;
    }

    sendError(res, 'Not Found', 404);

  } catch (error) {
    console.error('Server error:', error);
    sendError(res, '服务器内部错误');
  }
});

// 启动服务器
server.listen(CONFIG.PORT, async () => {
  console.log('='.repeat(50));
  console.log('用户反馈服务已启动');
  console.log('='.repeat(50));
  console.log(`访问地址: http://${CONFIG.HOST}:${CONFIG.PORT}`);
  console.log(`登录地址: http://${CONFIG.HOST}:${CONFIG.PORT}/api/auth/login`);
  console.log(`管理后台: http://${CONFIG.HOST}:${CONFIG.PORT}/admin.html`);
  console.log('='.repeat(50));

  // 初始化数据库
  initDatabase();

  // 初始化 toca Token
  await initTocaTokens();
});

// 优雅退出
process.on('SIGTERM', () => {
  console.log('正在关闭服务...');
  if (db) db.close();
  server.close(() => {
    console.log('服务已关闭');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n正在关闭服务...');
  if (db) db.close();
  server.close(() => {
    console.log('服务已关闭');
    process.exit(0);
  });
});
