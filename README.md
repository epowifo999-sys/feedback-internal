# 用户反馈 H5 页面

一个纯前端 H5 用户反馈页面，支持提交反馈到飞书多维表格。

## 功能特性

- 纯 HTML + CSS + JavaScript，单文件无需构建
- 移动端适配，兼容 iOS / Android WebView
- 表单校验与防重复提交
- 实时字数统计
- 自动获取设备信息
- 数据自动同步到飞书多维表格

## 项目结构

```
.
├── index.html    # 前端反馈页面
├── server.js     # Node.js 后端服务
└── README.md     # 说明文档
```

## 系统架构

- **登录**: toca 统一认证系统
- **数据存储**: 飞书多维表格
- **消息通知**: 飞书 IM

## 快速开始

### 1. 配置 toca 登录（公司内部认证）

#### 1.1 获取 toca 应用凭证

联系 toca 平台管理员获取：

- **App Key**（应用标识）
- **App Secret**（应用密钥）
- **Agent ID**（应用 agentId）
- **Space ID**（租户 ID，通常是 `0583d`）

#### 1.2 配置回调地址

在 toca 平台配置 OAuth 回调地址：
```
http://你的域名/api/auth/callback
```

本地开发时可使用：
```
http://localhost:3000/api/auth/callback
```

### 2. 配置飞书应用（表格和IM通知）

#### 2.1 创建飞书应用

1. 访问 [飞书开放平台](https://open.feishu.cn/app)
2. 点击「创建企业自建应用」
3. 填写应用名称（如「用户反馈收集」），选择应用类型为「企业内部应用」
4. 点击「确定创建」

#### 2.2 开通权限

进入应用详情页，点击「权限管理」，搜索并开通以下权限：

| 权限 | 说明 |
|------|------|
| `bitable:app` | 多维表格的读取和写入权限 |
| `bitable:record` | 多维表格记录的增删改查 |

> 搜索关键词：「多维表格」或「bitable」

#### 2.3 发布应用

1. 点击「版本管理与发布」
2. 点击「创建版本」
3. 填写版本号和更新说明
4. 点击「保存并发布」
5. 联系企业管理员审批通过

#### 2.4 获取应用凭证

在「凭证与基础信息」页面，获取：

- **App ID**（应用 ID）
- **App Secret**（应用密钥）

### 3. 创建多维表格

#### 3.1 创建表格

1. 在飞书中创建一个新的多维表格
2. 按以下格式创建字段：

| 字段名称 | 字段类型 | 说明 |
|---------|---------|------|
| 问题类型 | 文本 | 崩溃/功能异常/体验建议/其他 |
| 问题描述 | 文本 | 用户填写的详细描述 |
| 联系方式 | 文本 | 手机号或微信号 |
| 提交时间 | 文本 | 自动生成 |
| 设备信息 | 文本 | 自动获取的设备信息 |
| 反馈用户 | 文本 | 用户工号或标识 |

> 注意：字段名称必须与上述完全一致

#### 3.2 获取表格信息

1. 打开多维表格
2. 从浏览器地址栏复制 `app_token`
   - URL 格式：`https://example.feishu.cn/base/XXXXXXXXXXXXXX?table=YYYYYYYYYYYYYYYY`
   - `app_token` = `XXXXXXXXXXXXXX`
3. 在「表格设置」或浏览器 URL 中获取 `table_id`
   - `table_id` = `YYYYYYYYYYYYYYYY`（以 `tbl` 开头）

> 飞书文档获取 `app_token` 方法：
> - 打开文档 → 右上角「...」→「复制链接」
> - 链接中 `/base/` 后的字符串即为 `app_token`

### 4. 配置并启动服务

#### 4.1 修改配置

编辑 `server.js`，修改以下配置项：

```javascript
const CONFIG = {
  // ===== toca 登录配置 =====
  TOCA_APP_KEY: 'your_app_key_here',           // toca App Key
  TOCA_APP_SECRET: 'your_app_secret_here',     // toca App Secret
  TOCA_SPACE_ID: '0583d',                      // 租户ID
  TOCA_REDIRECT_URI: 'http://你的域名/api/auth/callback',  // 回调地址
  TOCA_AGENT_ID: 'your_agent_id_here',         // toca Agent ID

  // ===== 飞书表格和IM配置 =====
  FEISHU_APP_ID: 'cli_xxxxxxxxxxxxxxxx',       // 飞书 App ID
  FEISHU_APP_SECRET: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',  // 飞书 App Secret
  FEISHU_APP_TOKEN: 'xxxxxxxxxxxxxxxx',        // 多维表格 app_token
  FEISHU_TABLE_ID: 'tblxxxxxxxxxxxxx',         // 多维表格 table_id

  // 消息通知配置
  NOTIFICATION_USER_ID: 'ou_xxxxxxxxxxxxxxxx', // 接收通知的用户 open_id
  BITABLE_VIEW_URL: 'https://base.feishu.cn/base/xxx', // 表格访问链接

  // 服务端口号
  PORT: 3000,
};
```

#### 4.2 启动服务

```bash
# 进入项目目录
cd /Users/tcd-1223489/Documents/cc-用户反馈页面

# 启动服务（Node.js 内置 http 模块，无需安装依赖）
node server.js
```

看到以下输出表示启动成功：

```
==================================================
用户反馈服务已启动
==================================================
访问地址: http://localhost:3000
登录地址: http://localhost:3000/api/auth/login
API 接口: http://localhost:3000/api/submit
==================================================
请确保已配置 toca 应用信息:
  - TOCA_APP_KEY: 已配置 ✓
  - TOCA_APP_SECRET: 已配置 ✓
  - TOCA_AGENT_ID: 已配置 ✓
  - TOCA_REDIRECT_URI: 已配置 ✓
==================================================
飞书配置（表格和IM）:
  - FEISHU_APP_ID: 已配置 ✓
  - FEISHU_APP_SECRET: 已配置 ✓
  - FEISHU_APP_TOKEN: 已配置 ✓
  - FEISHU_TABLE_ID: 已配置 ✓
==================================================
```

#### 4.3 访问页面

1. 在浏览器中打开：`http://localhost:3000`
2. 点击「立即登录」跳转到 toca 认证页面
3. 完成登录后自动返回反馈页面

或使用二维码工具生成二维码，手机扫码测试。

## API 接口

### GET /api/auth/login

跳转到 toca 登录授权页面

- 自动重定向到 toca OAuth 授权页面
- 用户完成授权后跳转到 `/api/auth/callback`
- 登录成功后写入 `sessionId` cookie

### GET /api/auth/callback

toca OAuth 回调处理

- 接收 `code` 和 `state` 参数
- 校验 state 防止 CSRF 攻击
- 获取用户信息并创建 session
- 写入 cookie 并重定向回首页

### GET /api/user/info

获取当前登录用户信息

**响应结果：**

```json
// 已登录
{
  "success": true,
  "loggedIn": true,
  "openId": "xxx",
  "employeeNo": "E12345",
  "outerMemberId": "xxx"
}

// 未登录
{
  "success": true,
  "loggedIn": false
}
```

### POST /api/submit

提交反馈数据

**请求头：**
- 需要携带 `Cookie: sessionId=xxx`（自动携带）

**请求参数：**

```json
{
  "type": "崩溃",
  "description": "详细描述问题...",
  "contact": "13800138000",
  "deviceInfo": "iOS 16.5 | Mozilla/5.0...",
  "images": ["data:image/png;base64,..."]
}
```

**响应结果：**

```json
// 成功
{
  "success": true,
  "message": "提交成功"
}

// 未登录
{
  "success": false,
  "message": "请先登录"
}
// HTTP Status: 401

// 失败
{
  "success": false,
  "message": "错误信息"
}
```

### GET /api/health

健康检查

```json
{
  "success": true,
  "status": "ok",
  "time": "2024-01-15 10:30:00"
}
```

## 部署建议

### 生产环境部署

#### 使用 PM2 部署

```bash
# 安装 PM2
npm install -g pm2

# 启动服务
pm2 start server.js --name feedback-server

# 查看状态
pm2 status

# 查看日志
pm2 logs feedback-server

# 重启服务
pm2 restart feedback-server

# 停止服务
pm2 stop feedback-server
```

#### 使用 Docker 部署

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY server.js .
COPY index.html .

EXPOSE 3000

CMD ["node", "server.js"]
```

```bash
# 构建镜像
docker build -t feedback-server .

# 运行容器
docker run -d -p 3000:3000 --name feedback feedback-server
```

#### 使用 Nginx 反向代理

```nginx
server {
    listen 80;
    server_name feedback.example.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### HTTPS 配置

如果使用 HTTPS，需要修改前端代码中的 `API_BASE_URL`：

```javascript
// index.html
const API_BASE_URL = 'https://your-domain.com';  // 修改为 HTTPS 地址
```

## 常见问题

### 1. 飞书 API 返回 "app permission error"

**原因**：应用未开通所需权限

**解决**：
1. 进入飞书开放平台 → 应用详情 → 权限管理
2. 搜索并开通 `bitable:app` 权限
3. 重新发布应用版本

### 2. 飞书 API 返回 "app is not released"

**原因**：应用未发布或发布未通过审批

**解决**：
1. 进入「版本管理与发布」
2. 创建新版本并发布
3. 联系企业管理员审批通过

### 3. 飞书 API 返回 "token is invalid"

**原因**：App ID 或 App Secret 配置错误

**解决**：检查 `server.js` 中的配置是否正确

### 4. 飞书 API 返回 "resource not found"

**原因**：app_token 或 table_id 错误

**解决**：
1. 检查 app_token 是否完整（不含特殊字符）
2. 检查 table_id 是否正确（以 `tbl` 开头）
3. 确认应用有权限访问该表格

### 5. 前端报错 "CORS error"

**原因**：浏览器跨域限制

**解决**：
- 确保前端请求的地址与后端服务地址同源
- 或正确配置 CORS 白名单

### 6. 如何修改表格字段名称？

如果修改了表格字段名称，需要同步修改 `server.js` 中的字段映射：

```javascript
const record = {
  '你的问题类型字段名': body.type,
  '你的问题描述字段名': body.description,
  '你的联系方式字段名': body.contact || '',
  '你的提交时间字段名': formatDate(),
  '你的设备信息字段名': body.deviceInfo || ''
};
```

## 安全建议

1. **保护 App Secret**：不要将 `server.js` 中的 `FEISHU_APP_SECRET` 提交到代码仓库，建议使用环境变量
2. **启用 HTTPS**：生产环境必须使用 HTTPS
3. **限制访问**：生产环境配置 IP 白名单或增加接口鉴权
4. **速率限制**：增加接口请求频率限制，防止恶意刷接口

## 环境变量配置（可选）

可以修改 `server.js` 使用环境变量读取配置：

```javascript
const CONFIG = {
  FEISHU_APP_ID: process.env.FEISHU_APP_ID || 'cli_xxxxxxxxxxxxxxxx',
  FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET || 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  FEISHU_APP_TOKEN: process.env.FEISHU_APP_TOKEN || 'xxxxxxxxxxxxxxxx',
  FEISHU_TABLE_ID: process.env.FEISHU_TABLE_ID || 'tblxxxxxxxxxxxxx',
  PORT: parseInt(process.env.PORT) || 3000,
  ...
};
```

启动时传入环境变量：

```bash
FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx node server.js
```

## License

MIT
