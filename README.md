# 宠物养护与洗护预约

这是一个同源 Node.js + Express 应用：浏览器负责预约界面，服务端通过 Supabase PostgreSQL transaction pooler 读写 `public.grooming_appointments`，数据库连接串不会发送到浏览器。

## 本地启动

1. 复制 `.env.example` 为 `.env`。
2. 在 Supabase Dashboard 的 **Connect → Transaction pooler** 中复制端口为 `6543` 的连接串，填入 `DATABASE_URL`。应用会强制启用 `uselibpqcompat=true&sslmode=require`。
3. 运行 `pnpm install`，然后运行 `pnpm dev`。
4. 打开 `http://localhost:3000`。

`public/index.html` 是应用页面入口。根目录原有的 `index.html` 仅保留作为初始设计存档，不由服务器提供。

## 数据库与测试

- 可复现迁移位于 `supabase/migrations/202607130001_create_grooming_appointments.sql`。
- 运行 `pnpm test` 执行预约规则、接口状态、Cookie 身份隔离和静态页面测试。
- 运行 `pnpm check` 执行服务端语法检查和全部自动化测试。

主要接口：

- `GET /api/appointments/availability?date=YYYY-MM-DD`
- `POST /api/appointments`
- `GET /api/appointments`
- `PATCH /api/appointments/:id`
- `POST /api/appointments/:id/cancel`
- `GET /api/health`
