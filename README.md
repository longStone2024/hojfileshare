# HOJ 云盘

基于 **OJ 存储后端** 的个人云盘系统。文件实际存放在 OJ（Online Judge）上，本系统只做元数据管理、鉴权、配额、分享。

- 🐳 三容器部署：`frontend` (Nginx) + `backend` (Node.js) + `db` (PostgreSQL)
- 🔐 双登录方式：内部账号密码 / OJ 主页签名验证（注册后设置密码即可走密码登录）
- 🗂️ 完整文件管理：上传、下载、新建文件夹、移动、重命名、删除、**文件夹整包 ZIP 下载**
- 📤 上传进度条（多文件顺序上传）
- 🔗 短链分享：独立分享页、有效期、最大下载次数、访问密码
- 👥 多用户配额管理，管理后台可视化
- 🌐 多 OJ 提供方，管理员可配置多个

---

## 目录

- [架构](#架构)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [使用说明](#使用说明)
- [OJ 对接说明](#oj-对接说明)
- [运维](#运维)
- [常见问题](#常见问题)
- [安全建议](#安全建议)

---

## 架构

```
┌──────────────┐  /api, /s   ┌──────────────┐   pg    ┌──────────────┐
│  frontend    │ ──────────► │  backend     │ ──────► │  db          │
│  nginx:80    │  proxy_pass │  node:3000   │  SQL    │ postgres:16  │
└──────────────┘             └──────────────┘         └──────────────┘
       │                            │
       │                            │  HTTP (上传/下载)
       ▼                            ▼
  浏览器/用户                    OJ 提供方 (例如 ssf.hdoi.cn)
                                 - POST /api/login                 获取 Authorization
                                 - POST /api/file/upload-md-file   上传文件
                                 - GET  /api/get-user-home-info    签名验证
```

- 只有 `frontend` 对外暴露端口（默认 8080），`backend` 和 `db` 仅在内网通信。
- 文件**不落本地磁盘**，上传后即丢到 OJ，本地只存元数据（`storage_url` 指向 OJ 上的文件地址）。

---

## 快速开始

### 前置条件

- Docker 20.10+
- Docker Compose 插件（`docker compose` 命令可用）
- 一台能访问 OJ 的设备（NAS / 服务器 / 家用主机均可）

### 步骤

**1. 拉取项目到任意目录**

```bash
git clone <你的仓库地址> cloud-drive
cd cloud-drive
```

或直接把项目目录（含 `docker-compose.yml`）拷贝过来。

**2. 准备环境变量**

```bash
cp .env.example .env
```

编辑 `.env`（至少要改三处）：

```ini
POSTGRES_PASSWORD=一个强随机密码
ROOT_PASSWORD=你的root登录密码
FRONTEND_PORT=8080
```

生成随机密码可以用：

```bash
openssl rand -hex 24
```

**3. 启动**

```bash
sudo docker compose up -d --build
```

首次构建会拉取镜像 + 装依赖，约 1–3 分钟。启动完成后：

```bash
sudo docker compose ps
# 三个容器都应是 running / healthy

sudo docker compose logs --tail=30 backend
# 期望看到：
#   [db] connected
#   [init] 已创建 root，密码：xxxx
#   [backend] listening on 3000
```

**4. 打开浏览器**

访问 `http://<你的IP>:8080`，用以下账号登录：

- 用户名：`root`
- 密码：`.env` 里的 `ROOT_PASSWORD`

**5. 配置 OJ 存储（必做，否则无法上传）**

登录后进入右上角「**管理**」→「OJ 存储提供方」→ 新增：

| 字段 | 示例值 |
|---|---|
| 名称 | `SSF OJ` |
| Base URL | `http://ssf.hdoi.cn` |
| 上传账号 | 向 OJ 管理员申请的上传账号 |
| 上传密码 | 对应密码 |
| gid | `114514`（与管理员确认） |

保存后即可在「文件」页正常上传。

---

## 配置说明

全部配置通过 `.env` 传递。

### 数据库

| 变量 | 默认值 | 说明 |
|---|---|---|
| `POSTGRES_DB` | `cloud` | 数据库名 |
| `POSTGRES_USER` | `cloud` | 数据库用户 |
| `POSTGRES_PASSWORD` | **必填** | 数据库密码 |
| `db_data` volume | 自动管理 | 数据持久化位置，**不要删** |

> ⚠️ 修改 `POSTGRES_*` 后老数据卷**不会重建**。要换用户/库名需自行迁移或 `docker compose down -v` 重建（会丢数据）。

### 后端

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ROOT_PASSWORD` | **必填** | 首次启动创建 root 的密码 |
| `SESSION_TTL_DAYS` | `7` | 登录会话有效期（天） |
| `DEFAULT_USER_QUOTA_MB` | `1024` | 新用户默认配额 |
| `MAX_UPLOAD_MB` | `100` | 单文件上传上限 |
| `PROXY_DOWNLOAD` | `0` | `1`=下载走服务器代理（OJ 有防盗链时开）；`0`=直接 302 到 OJ |

### 打包下载（可选）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ZIP_MAX_TOTAL_MB` | `2048` | 单次 ZIP 总大小上限 |
| `ZIP_MAX_FILES` | `2000` | 单次 ZIP 文件数上限 |
| `ZIP_CONCURRENCY` | `4` | 打包时并发从 OJ 拉取文件的并发数 |

### 前端

| 变量 | 默认值 | 说明 |
|---|---|---|
| `FRONTEND_PORT` | `8080` | 对外 HTTP 端口 |

---

## 使用说明

### 登录 / 注册

**方式一：本地账号**

用管理员创建的账号，或首次通过 OJ 注册后设置的账号，直接在「**账号登录**」输入用户名密码。

**方式二：OJ 签名（首次注册）**

1. 切到「**OJ 签名登录 / 注册**」标签
2. 选择 OJ、填 OJ 用户名、可选填**想要的云盘用户名**（实时检查是否被占用）
3. 点「生成 UUID」→ 复制生成的 UUID
4. 打开 OJ → 个人主页 → **签名最前面**粘贴这串 UUID → 保存
5. 回云盘点「我改好了，验证」
6. 首次注册会弹「设置密码」，设置后即可用「用户名 + 密码」登录

> 已在 OJ 注册过的用户再次点 OJ 签名登录可直接进入，无需重新设置密码。

### 文件操作

| 操作 | 入口 |
|---|---|
| 上传 | 顶部「上传文件」按钮（支持多选，显示进度条） |
| 新建文件夹 | 顶部「新建文件夹」 |
| 进入文件夹 | 点击文件夹名 |
| 单文件下载 | 文件行「下载」按钮 |
| 文件夹打包下载 | 文件夹行「打包下载」→ 浏览器下载 `<文件夹名>.zip` |
| 移动 | 文件行「移动」→ 目录树里点目标目录 → 「移动到这里」 |
| 重命名 | 文件行「重命名」 |
| 删除 | 文件行「删除」（文件夹会递归删除） |
| 分享 | 文件行「分享」→ 设置有效期/次数/密码 → 得到短链 |

### 分享

创建分享后得到短链，例如 `http://NAS:8080/s/abc12345`：

- 打开后是独立分享页，只显示文件名、大小、有效期、剩余次数、下载按钮
- 有密码的分享先展示密码输入框
- 下载成功后 `download_count` 加 1，达到上限即失效
- 分享者可在「我的分享」里查看、取消

### 管理后台

仅 `admin` / `root` 角色可见。可管理：

- 用户：改配额、改密码、设置角色、删除用户
- OJ 存储提供方：增删、改账号/gid、启用/禁用
- 概览：用户数、文件数、分享数、总占用

---

## OJ 对接说明

后端通过管理员配置的凭证与 OJ 通信。本项目假设 OJ 满足以下接口：

### 1. 登录

```
POST /api/login
Content-Type: application/json

{ "username": "xxx", "password": "xxx" }
```

**Token 位置**：优先从响应头 `Authorization` 提取（兼容剥掉 `Bearer ` 前缀）；若没有，回退到 JSON body 的 `data.token`。

### 2. 上传

```
POST /api/file/upload-md-file
authorization: <上一步拿到的 token>
Content-Type: multipart/form-data

gid: 114514
file: <binary>
```

返回：

```json
{
  "status": 200,
  "data": { "link": "/api/public/file/xxx.png" },
  "msg": "success"
}
```

后端拼接 `<base_url><link>` 得到完整下载地址入库。

### 3. 用户签名（登录验证）

```
GET /api/get-user-home-info?username=xxx
```

返回体里 `data.signature` 以用户提交的 UUID 开头即验证通过。

> 不是这套接口的 OJ，可通过调整 `oj_providers` 表中的 `login_path`、`upload_path`、`home_info_path`、`token_json_path` 适配；如果响应格式差异大，需在 `backend/src/services/oj.js` 里微调。

---

## 运维

### 常用命令

```bash
# 查看状态
sudo docker compose ps
sudo docker compose logs -f --tail=100 backend

# 只重建后端（改了 backend 代码）
sudo docker compose build --no-cache backend
sudo docker compose up -d --force-recreate backend

# 只重建前端（改了 public/ 或 nginx.conf）
sudo docker compose build --no-cache frontend
sudo docker compose up -d --force-recreate frontend

# 停止（保留数据卷）
sudo docker compose down

# 停止并删除数据卷（⚠️ 会丢数据库）
sudo docker compose down -v
```

### 数据库备份 / 恢复

```bash
# 备份
sudo docker compose exec -T db pg_dump -U cloud -d cloud > backup-$(date +%F).sql

# 恢复
cat backup-2026-10-27.sql | sudo docker compose exec -T db psql -U cloud -d cloud
```

### 数据库初始化

首次启动时 `db_data` 卷为空，Postgres 会自动执行 `db/init.sql` 建表。

**若 `init.sql` 后续改动**（比如新增字段），`up -d` 不会重跑。手动 apply：

```bash
sudo docker compose exec -T db psql -U cloud -d cloud < db/init.sql
```

或开发阶段直接 `down -v` 清卷重来。

> 后端 `db.js` 里的 `init()` 会自动执行可重复执行的 migration（如 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`），主要结构变更仍建议走迁移脚本。

### 迁移项目目录

同卷内 `mv` 即可，`db_data` 是 named volume 存在 Docker 数据目录，不受影响：

```bash
sudo docker compose down
sudo mv /old/path/cloud-drive /new/path/cloud-drive
cd /new/path/cloud-drive
sudo docker compose up -d
```

### 对外暴露（可选）

默认只局域网访问 `http://NAS:8080`。想公网访问但**没有公网 IP** 时，推荐 Cloudflare Tunnel（免费）：

```yaml
# 加到 docker-compose.yml
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run --token ${CLOUDFLARE_TUNNEL_TOKEN}
    networks:
      - internal
```

在 Cloudflare Zero Trust 里把 `drive.你的域名.com` 指向 `http://frontend:80` 即可，自动 HTTPS、DDNS。

---

## 常见问题

**Q：访问 8080 显示 403 Forbidden**
容器内 Nginx 用户读不到 `index.html`。Dockerfile 里应该有 `RUN chmod -R a+rX /usr/share/nginx/html`，重建前端即可。

**Q：`failed to solve: "/public": not found`**
`frontend/public/` 目录不存在或文件名拼错（如 `pubilc`）。修复后 `build --no-cache frontend`。

**Q：后端报 `Cannot find module './routes/files'`**
`backend/src/routes/` 下少了 `.js` 文件或文件名拼错。目录应为：`admin.js / auth.js / files.js / shares.js`。

**Q：`relation "users" does not exist`**
`db/init.sql` 未被执行。要么 `down -v` 重建，要么手动 `psql < db/init.sql`。

**Q：上传失败「未配置存储提供方」**
先在管理后台配置至少一个 OJ 提供方。

**Q：上传失败「OJ 登录失败」**
OJ 的登录接口返回里没找到 token。检查 OJ 是否在响应头里返回 `Authorization`，或调整 `oj_providers.token_json_path`。用 `curl -i` 手动验证：

```bash
curl -i -X POST http://ssf.hdoi.cn/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"xxx","password":"xxx"}'
```

**Q：文件夹打包下载变成 `.ERROR.txt`**
ZIP 里某个文件在 OJ 侧失效（404/403），对应位置会生成 `文件名.ERROR.txt` 说明，其他文件不受影响。

**Q：老 OJ 用户没有密码，怎么登录**
下次走 OJ 签名登录后会自动弹「设置密码」；或管理员在「用户管理 → 改密码」直接设一个。

---

## 安全建议

1. **改掉默认密码**：`ROOT_PASSWORD`、`POSTGRES_PASSWORD` 都用强随机值。
2. **不要对外暴露 backend 的 3000 端口**，所有请求都经过 `frontend`。
3. **`.env` 不入库**：已配 `.gitignore`，也不要贴给他人。
4. **备份数据库**：OJ 侧挂了本地元数据跟着挂，定期 `pg_dump` 到别的机器。
5. **OJ 凭证权限**：给本系统的 OJ 账号仅授予必要权限（上传 + 读签名），不要用超级管理员账号。
6. **反代 / 隧道记得配 HTTPS**：走 Cloudflare Tunnel 或 Nginx + Let's Encrypt。
7. **定期升级镜像**：`docker compose pull && docker compose up -d` 保持 Postgres / Nginx / Node 为最新的 patch 版本。

---

## 项目结构

```
cloud-drive/
├── docker-compose.yml        # 三服务编排
├── .env.example              # 环境变量样例
├── db/
│   └── init.sql              # 首次启动自动执行建表
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js          # Express 入口、路由挂载
│       ├── config.js         # 读取环境变量
│       ├── db.js             # pg 连接池 + migration
│       ├── middleware/auth.js# 会话校验、角色校验
│       ├── services/oj.js    # OJ 登录/上传/主页签名
│       └── routes/
│           ├── auth.js       # 登录、OJ 挑战、设置密码
│           ├── files.js      # 文件 CRUD、上传、下载、ZIP 打包
│           ├── shares.js     # 创建/管理分享 + 公开访问
│           └── admin.js      # 用户管理、OJ 提供方、统计
└── frontend/
    ├── Dockerfile
    ├── nginx.conf            # /api、/s、SPA 路由
    └── public/
        ├── index.html        # SPA 主页面
        ├── app.js            # 登录、文件、管理逻辑
        ├── style.css
        ├── share.html        # 独立分享页
        ├── share.css
        └── share.js
```