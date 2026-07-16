# 宠物养护、动态与洗护预约

同源 Node.js + Express 应用，提供邮箱账号、宠物档案、公开养护前后动态、多图上传、评论、员工审核和洗护预约。账号、密码哈希、会话和业务数据均由应用直接写入 PostgreSQL；Supabase 仅提供 PostgreSQL 和图片 Storage，不使用 Supabase Auth。

## 本地配置

1. 复制 `.env.example` 为 `.env`。
2. 在 Supabase **Connect → Transaction pooler** 中复制端口为 `6543` 的连接串，填写 `DATABASE_URL`。
3. 从 Supabase **Project Settings → API** 填写图片 Storage 使用的 `SUPABASE_URL` 和仅供服务端使用的 `SUPABASE_SERVICE_ROLE_KEY`。
4. 在 Supabase SQL Editor 按文件名顺序执行 `supabase/migrations` 下的迁移。迁移会创建本地账号、哈希会话、宠物、动态、评论表及 `care-dynamics` Storage bucket。
5. 运行 `pnpm install`、`pnpm dev`，打开 `http://localhost:3000`。

不要将 `DATABASE_URL` 或 `SUPABASE_SERVICE_ROLE_KEY` 放进浏览器代码、提交到 Git，或使用 `SUPABASE_SERVICE_ROLE_KEY` 作为前端配置。

## 员工账号

用户在应用中填写昵称、邮箱和密码后会直接完成注册并登录，不需要邮件确认。密码使用带随机盐的 `scrypt` 哈希保存，浏览器只接收随机的 HttpOnly 会话 Cookie。

所有新注册账号默认是顾客。由管理员在 SQL Editor 中提升指定账号：

```sql
update public.profiles
set role = 'staff'
where email = 'staff@example.com';
```

员工可查询全部宠物、为任意宠物发布动态，并隐藏、恢复或删除动态和评论。顾客只能管理自己的宠物和内容。

## 接口

- 认证：`POST /api/auth/register`、`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/session`
- 宠物：`GET/POST /api/pets`、`PATCH/DELETE /api/pets/:id`
- 动态：`GET/POST /api/posts`、`PATCH/DELETE /api/posts/:id`、`POST /api/posts/:id/moderation`
- 评论：`GET/POST /api/posts/:id/comments`、`PATCH/DELETE /api/comments/:id`、`POST /api/comments/:id/moderation`
- 预约：`GET /api/appointments/availability`、`GET/POST /api/appointments`、`PATCH /api/appointments/:id`、`POST /api/appointments/:id/cancel`

动态图片通过 `multipart/form-data` 的 `images` 字段上传，每条最多 6 张、单张最大 8 MB。服务端验证 JPEG/PNG/WebP 实际内容，将最长边限制为 2048 像素并转换成 WebP。

旧匿名预约记录会保留在数据库中，但不会自动归属或显示到新账号。新预约必须登录并选择当前顾客自己的宠物。

## 验证

- `pnpm test`：运行接口权限、预约规则、静态页面和真实图片转换测试。
- `pnpm check`：执行服务端、浏览器脚本语法检查和全部自动化测试。
