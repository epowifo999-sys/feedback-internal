/**
 * 用户反馈服务 - Node.js 后端
 * 提供 /api/submit 接口，将反馈数据写入飞书多维表格
 *
 * 使用 Node.js 内置 http 模块，无需额外依赖
 */

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

// ==================== 配置项 ====================
// 请修改以下配置为你自己的飞书应用信息
const CONFIG = {
  // 飞书应用凭证
  FEISHU_APP_ID: 'cli_a93438e196f85bc4',
  FEISHU_APP_SECRET: 'pnbmT0e2YWBMuPXnw17AXeSlM8h7qZW5',

  // 多维表格信息
  FEISHU_APP_TOKEN: 'E0bxbqJLDa9g8CsnwmHcyLHjnPh',
  FEISHU_TABLE_ID: 'tblYCxDTCaR8KSMT',

  // 服务端口号
  PORT: 3000,

  // 飞书 API 地址
  FEISHU_TOKEN_URL: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
  FEISHU_USER_TOKEN_URL: 'https://open.feishu.cn/open-apis/auth/v3/user_access_token/internal',
  FEISHU_OAUTH_URL: 'https://open.feishu.cn/open-apis/authen/v1/index',
  FEISHU_RECORD_URL: (appToken, tableId) =>
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,

  // 消息通知配置
  // 接收通知的用户 open_id（登录飞书后会在控制台打印出来，复制到这里）
  NOTIFICATION_USER_ID: 'ou_271831e3cb4c217421dc2dcb046724db',

  // 多维表格访问链接（用于消息中点击跳转）
  BITABLE_VIEW_URL: 'https://base.feishu.cn/base/E0bxbqJLDa9g8CsnwmHcyLHjnPh'
};

// 用户 Token 存储（生产环境应使用 Redis 或数据库）
const userTokens = new Map();

// ==================== 工具函数 ====================

/**
 * 发送 HTTP 请求
 */
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

/**
 * 获取飞书 tenant_access_token
 */
async function getFeishuToken() {
  const response = await request({
    method: 'POST',
    protocol: 'https:',
    hostname: 'open.feishu.cn',
    path: '/open-apis/auth/v3/tenant_access_token/internal',
    headers: {
      'Content-Type': 'application/json'
    }
  }, {
    app_id: CONFIG.FEISHU_APP_ID,
    app_secret: CONFIG.FEISHU_APP_SECRET
  });

  if (response.data.code !== 0) {
    throw new Error(`获取飞书 Token 失败: ${response.data.msg || response.data.message}`);
  }

  return response.data.tenant_access_token;
}

/**
 * 写入飞书多维表格
 */

/**
 * 使用授权码换取用户 user_access_token
 */
async function getUserAccessToken(code) {
  // 先获取 tenant_token
  const tenantToken = await getFeishuToken();

  const response = await request({
    method: 'POST',
    protocol: 'https:',
    hostname: 'open.feishu.cn',
    path: '/open-apis/authen/v1/oidc/access_token',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tenantToken}`
    }
  }, {
    grant_type: 'authorization_code',
    code: code
  });

  console.log('获取用户 Token 响应:', JSON.stringify(response.data, null, 2));

  if (response.data.code !== 0) {
    throw new Error(`获取用户 Token 失败: ${response.data.msg || response.data.message}`);
  }

  const accessToken = response.data.data.access_token;
  const refreshToken = response.data.data.refresh_token;
  const expiresIn = response.data.data.expires_in;

  // 用 access_token 获取用户信息
  const userInfoResponse = await request({
    method: 'GET',
    protocol: 'https:',
    hostname: 'open.feishu.cn',
    path: '/open-apis/authen/v1/user_info',
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  console.log('获取用户信息响应:', JSON.stringify(userInfoResponse.data, null, 2));

  let openId = 'user_' + Date.now(); // 备用ID
  let userName = '未知用户';
  let userAvatar = '';

  if (userInfoResponse.data.code === 0 && userInfoResponse.data.data) {
    const userData = userInfoResponse.data.data;
    openId = userData.open_id || userData.union_id || openId;
    userName = userData.name || userData.en_name || '未知用户';
    userAvatar = userData.avatar_url || userData.avatar || '';
  }

  return {
    accessToken: accessToken,
    refreshToken: refreshToken,
    expiresIn: expiresIn,
    openId: openId,
    userName: userName,
    userAvatar: userAvatar
  };
}

/**
 * 使用用户 Token 写入飞书多维表格
 */
async function writeToFeishu(userToken, record) {
  const url = CONFIG.FEISHU_RECORD_URL(CONFIG.FEISHU_APP_TOKEN, CONFIG.FEISHU_TABLE_ID);

  const parsedUrl = new URL(url);

  const response = await request({
    method: 'POST',
    protocol: parsedUrl.protocol,
    hostname: parsedUrl.hostname,
    path: parsedUrl.pathname + parsedUrl.search,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${userToken}`
    }
  }, {
    fields: record
  });

  console.log('飞书 API 响应:', JSON.stringify(response.data, null, 2));

  if (response.data.code !== 0) {
    const errorMsg = response.data.msg || response.data.message || JSON.stringify(response.data);
    throw new Error(`写入飞书表格失败: ${errorMsg}`);
  }

  return response.data;
}

/**
 * 发送飞书应用消息通知
 */
async function sendNotification(userName, type, description, contact) {
  // 如果没有配置接收者，则不发送通知
  if (!CONFIG.NOTIFICATION_USER_ID) {
    console.log(`[${formatDate()}] 未配置消息接收者，跳过通知`);
    return;
  }

  try {
    // 获取 tenant_access_token（应用身份）
    const tenantToken = await getFeishuToken();

    // 构建消息内容（使用普通文本消息，更可靠）
    let messageText = `📢 新用户反馈通知\n\n`;
    messageText += `👤 反馈用户：${userName || '匿名用户'}\n`;
    messageText += `📋 问题类型：${type}\n`;
    messageText += `📝 问题描述：${description.length > 100 ? description.substring(0, 100) + '...' : description}\n`;
    if (contact) {
      messageText += `📞 联系方式：${contact}\n`;
    }
    messageText += `\n📊 查看多维表格：${CONFIG.BITABLE_VIEW_URL}`;

    const response = await request({
      method: 'POST',
      protocol: 'https:',
      hostname: 'open.feishu.cn',
      path: '/open-apis/im/v1/messages?receive_id_type=open_id',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tenantToken}`
      }
    }, {
      receive_id: CONFIG.NOTIFICATION_USER_ID,
      msg_type: 'text',
      content: JSON.stringify({ text: messageText })
    });

    console.log('消息推送响应:', JSON.stringify(response.data, null, 2));

    if (response.data.code !== 0) {
      console.error(`[${formatDate()}] 发送通知失败:`, response.data.msg || response.data.message);
    } else {
      console.log(`[${formatDate()}] 消息通知发送成功`);
    }
  } catch (error) {
    console.error(`[${formatDate()}] 发送通知出错:`, error.message);
  }
}

/**
 * 格式化日期
 */
function formatDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
         `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 解析请求体
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 设置 CORS 响应头
 */
function setCORS(res, allowedOrigin = '*') {
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/**
 * 发送 JSON 响应
 */
function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * 发送错误响应
 */
function sendError(res, message, statusCode = 500) {
  sendJSON(res, statusCode, { success: false, message });
}

/**
 * 发送成功响应
 */
function sendSuccess(res, data = {}) {
  sendJSON(res, 200, { success: true, ...data });
}

/**
 * 获取 MIME 类型
 */
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

// ==================== 路由处理 ====================

/**
 * 处理静态文件请求
 */
async function serveStatic(req, res, filePath) {
  try {
    const fullPath = path.join(__dirname, filePath);
    const stats = await fs.promises.stat(fullPath);

    if (!stats.isFile()) {
      return false;
    }

    const content = await fs.promises.readFile(fullPath);
    res.writeHead(200, { 'Content-Type': getMimeType(fullPath) });
    res.end(content);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 处理飞书 OAuth 回调
 */
async function handleOAuthCallback(req, res) {
  try {
    const query = url.parse(req.url, true).query;
    const code = query.code;

    if (!code) {
      // 授权失败或用户取消
      const errorMsg = query.error || '授权失败';
      return res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>授权失败</title>
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
            <h2>授权失败</h2>
            <p>${errorMsg}</p>
            <a href="/" class="btn">返回重试</a>
          </div>
        </body>
        </html>
      `);
    }

    // 使用 code 换取用户 token
    console.log(`[${formatDate()}] 正在用 code 换取用户 token...`);
    const userInfo = await getUserAccessToken(code);
    console.log(`[${formatDate()}] 获取到用户 token, openId: ${userInfo.openId}`);

    // 存储用户 token
    userTokens.set(userInfo.openId, {
      accessToken: userInfo.accessToken,
      refreshToken: userInfo.refreshToken,
      expiresAt: Date.now() + userInfo.expiresIn * 1000,
      userName: userInfo.userName,
      userAvatar: userInfo.userAvatar
    });

    // 打印当前所有存储的 token（调试用）
    console.log(`[${formatDate()}] 当前存储的用户 token 列表:`, Array.from(userTokens.keys()));

    console.log(`[${formatDate()}] 用户登录成功: ${userInfo.openId}, 姓名: ${userInfo.userName}`);
    console.log(`[${formatDate()}] === 如需接收消息通知，请将以下 open_id 复制到 CONFIG.NOTIFICATION_USER_ID 中 ===`);
    console.log(`[${formatDate()}] NOTIFICATION_USER_ID: ${userInfo.openId}`);
    console.log(`[${formatDate()}] =====================================================================`);

    // 返回成功页面，自动跳转到首页
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>登录成功</title>
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
          <div class="icon">✅</div>
          <h2>登录成功</h2>
          <p>正在跳转回反馈页面...</p>
        </div>
        <script>
          // 存储用户信息到 localStorage
          localStorage.setItem('feishu_openId', '${userInfo.openId}');
          localStorage.setItem('feishu_userName', '${userInfo.userName || ''}');
          localStorage.setItem('feishu_userAvatar', '${userInfo.userAvatar || ''}');
          // 跳转到首页
          setTimeout(() => {
            window.location.href = '/';
          }, 1500);
        </script>
      </body>
      </html>
    `);

  } catch (error) {
    console.error(`[${formatDate()}] OAuth 回调错误:`, error.message);
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>授权出错</title>
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
          <h2>授权出错</h2>
          <p>${error.message}</p>
          <a href="/" class="btn">返回重试</a>
        </div>
      </body>
      </html>
    `);
  }
}

/**
 * 处理 /api/submit 接口
 */
async function handleSubmit(req, res) {
  try {
    const body = await parseBody(req);

    // 参数校验
    if (!body.type || !body.description) {
      return sendError(res, '缺少必要参数：type 和 description 为必填项', 400);
    }

    // 检查用户是否已登录
    const openId = body.openId;
    console.log(`[${formatDate()}] 收到提交请求, openId: ${openId}`);
    console.log(`[${formatDate()}] 当前存储的用户 token 列表:`, Array.from(userTokens.keys()));

    if (!openId) {
      console.log(`[${formatDate()}] 缺少 openId`);
      return sendError(res, '请先登录飞书', 401);
    }

    if (!userTokens.has(openId)) {
      console.log(`[${formatDate()}] openId 未在 token 存储中找到: ${openId}`);
      return sendError(res, '请先登录飞书', 401);
    }

    const userToken = userTokens.get(openId).accessToken;
    const userInfo = userTokens.get(openId);

    // 处理图片上传
    let imageUrls = [];
    const origin = req.headers.origin || `http://localhost:${CONFIG.PORT}`;
    if (body.images && Array.isArray(body.images) && body.images.length > 0) {
      const uploadDir = path.join(__dirname, 'uploads');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      for (let i = 0; i < body.images.length; i++) {
        const base64Data = body.images[i].replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        const filename = `${Date.now()}_${i}.png`;
        const filepath = path.join(uploadDir, filename);
        fs.writeFileSync(filepath, buffer);
        // 使用完整URL
        imageUrls.push(`${origin}/uploads/${filename}`);
      }
    }

    // 构建记录数据
    // 注意：字段名需要与你的多维表格字段名一致
    const record = {
      '问题类型': body.type,
      '问题描述': body.description,
      '联系方式': body.contact || '',
      '提交时间': formatDate(),
      '设备信息': body.deviceInfo || '',
      '图片链接': imageUrls.length > 0 ? imageUrls.join('\n') : ''
    };

    // 人员字段使用对象数组格式
    if (openId && openId.startsWith('ou_')) {
      record['反馈用户'] = [{
        'id': openId,
        'name': userInfo.userName || '',
        'en_name': userInfo.userName || ''
      }];
    } else if (openId) {
      // 备用方案：直接用文本存储用户标识
      record['反馈用户'] = userInfo.userName || openId;
    }

    // 使用用户 Token 写入（利用用户身份权限 base:record:create）
    await writeToFeishu(userToken, record);
    console.log(`[${formatDate()}] 反馈提交成功: ${body.type}`);

    // 发送通知给管理员
    sendNotification(userInfo.userName, body.type, body.description, body.contact);

    sendSuccess(res, { message: '提交成功' });

  } catch (error) {
    console.error(`[${formatDate()}] 提交失败:`, error.message);
    sendError(res, error.message || '服务器内部错误');
  }
}

// ==================== 主服务器 ====================

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // 设置 CORS
  setCORS(res, '*');

  // 处理预检请求
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 路由匹配
  try {
    // API 路由
    if (pathname === '/api/submit' && req.method === 'POST') {
      return await handleSubmit(req, res);
    }

    // 获取飞书授权 URL
    if (pathname === '/api/auth-url' && req.method === 'GET') {
      const redirectUri = `${req.headers.origin || `http://localhost:${CONFIG.PORT}`}/callback`;
      const authUrl = `${CONFIG.FEISHU_OAUTH_URL}?redirect_uri=${encodeURIComponent(redirectUri)}&app_id=${CONFIG.FEISHU_APP_ID}`;
      return sendSuccess(res, { authUrl });
    }

    // 飞书 OAuth 回调
    if (pathname === '/callback' && req.method === 'GET') {
      return await handleOAuthCallback(req, res);
    }

    // 图片上传目录访问
    if (pathname.startsWith('/uploads/') && req.method === 'GET') {
      const imagePath = path.join(__dirname, pathname);
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

    // 404
    sendError(res, 'Not Found', 404);

  } catch (error) {
    console.error('Server error:', error);
    sendError(res, '服务器内部错误');
  }
});

// 启动服务器
server.listen(CONFIG.PORT, () => {
  console.log('='.repeat(50));
  console.log('用户反馈服务已启动');
  console.log('='.repeat(50));
  console.log(`访问地址: http://localhost:${CONFIG.PORT}`);
  console.log(`API 接口: http://localhost:${CONFIG.PORT}/api/submit`);
  console.log('='.repeat(50));
  console.log('请确保已配置飞书应用信息:');
  console.log(`  - FEISHU_APP_ID: ${CONFIG.FEISHU_APP_ID === 'cli_xxxxxxxxxxxxxxxx' ? '未配置 ⚠️' : '已配置 ✓'}`);
  console.log(`  - FEISHU_APP_SECRET: ${CONFIG.FEISHU_APP_SECRET === 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' ? '未配置 ⚠️' : '已配置 ✓'}`);
  console.log(`  - FEISHU_APP_TOKEN: ${CONFIG.FEISHU_APP_TOKEN === 'xxxxxxxxxxxxxxxx' ? '未配置 ⚠️' : '已配置 ✓'}`);
  console.log(`  - FEISHU_TABLE_ID: ${CONFIG.FEISHU_TABLE_ID === 'tblxxxxxxxxxxxxx' ? '未配置 ⚠️' : '已配置 ✓'}`);
  console.log('='.repeat(50));
  console.log('提示: 首次使用需要登录飞书，使用用户身份权限写入表格');
  console.log('='.repeat(50));
});

// 优雅退出
process.on('SIGTERM', () => {
  console.log('正在关闭服务...');
  server.close(() => {
    console.log('服务已关闭');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n正在关闭服务...');
  server.close(() => {
    console.log('服务已关闭');
    process.exit(0);
  });
});
