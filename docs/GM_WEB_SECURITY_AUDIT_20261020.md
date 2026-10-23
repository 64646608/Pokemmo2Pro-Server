# GM 网页后台审计与上线门禁（2026-10-20）

## 范围、证据与局限

静态核对 `tools/web` 网页路由/鉴权/数据库接口，`server.game` 权限枚举与 GM 命令，`db/schemas/init.sql`、`db/clone_admin_to_LM5610.sql`、`compose.yml` 和 LOGIN/GAME 主启动类。原始源码来自本仓库 main；修复在 `qa-gm-admin-web-security-20261020`。**未访问东京实例文件系统或数据库，未测试真实账号。静态审计不是全量后门排除证明。**

## 实际风险

| 级别 | 证据 | 风险与动作 |
| --- | --- | --- |
| 严重 | `db/clone_admin_to_LM5610.sql` | 含固定口令的管理账号权限/角色克隆脚本；只有人工执行才会写入，尚无自动执行或生产已执行证据。必须检查生产是否存在非预期克隆账号及角色，确认所有管理员来源。此脚本**严禁执行**。 |
| 严重 | `server.login/Main.java`、`server.game/Main.java` | 原仓库有硬编码的数据库连接信息，且仓库公开。轮换相关密码、改为环境变量/密钥管理，核实数据库允许的源 IP。 |
| 严重 | `db/schemas/init.sql`、`compose.yml` | 含已公开的默认初始化口令，Compose 将 5432 端口映射到宿主机。必须确认未对公网开放，并禁用/重置默认管理员凭据。 |
| 高 | `tools/account_admin.py` | 旧版管理网页不要求登录，虽然默认绑定 localhost，绝不可直接暴露公网。统一使用有认证的 `tools/web/main.py`。 |
| 中 | `tools/web/admin_lib/server.py` | 原始 `/api/map/image` 在验证会话前可访问，QA 分支已补登录验证。 |
| 中 | `tools/web/admin_lib/handlers_auth.py` | 原始修改口令处理器引用未定义 `handler`，导致变更失败，QA 分支已修复。 |
| 高 | `tools/web/static/js/accounts.js`、`players.js`、`app.js` | 部分持久化文本经 `innerHTML` 输出，可能造成浏览器注入。QA 分支补这些入口转义，仍应继续系统性审计其它前端模块。 |
| 高 | `tools/web/admin_lib/db.py` | 原有 `force=True` 允许直接修改在线角色数据库，与游戏服内存可能竞态。新权限接口不接受 force，必须让角色离线，线上道具发放须走 GAME 业务接口。 |

## GM 权限实现

- 权限位写入 `public.character.permission`，支持 3=NORMAL、7=GM、10=ADM；不修改 `account.login_permission`。
- 仅修改**离线角色**；使用角色 ID 查询、数据库行锁、角色名称二次确认，并拒绝封禁账号。
- 角色重新登录后生效。后台会记录操作审计；授权前必须确保审计目录可写。
- 网页发道具仍是数据库模式，生产在线角色实时发放尚未接线。不得绕过在线保护，也不得将离线 SQL 发放解释为在线实时到账。

## 上线前必须完成

1. 使用真实东京服务器的**只读**状态信息确定 GAME/JAR 的版本、后台文件目录、数据库连接方式及部署用户，严禁猜测服务器 IP/URL。
2. 在隔离 PostgreSQL 数据库做管理员权限与道具发放实测，检查线上账号不会被误操作。
3. 执行管理员账号只读清单（输出只留本机、脱敏后用于审核）：

```sql
SELECT a.account_id, a.account_name, a.login_permission,
       c.id AS character_id, c.name AS character_name, c.permission
FROM public."account" a
LEFT JOIN public.character c ON c.account_id = a.account_id
WHERE c.permission >= 7 OR a.account_name = 'LM5610'
ORDER BY a.account_id, c.id;
```

4. 确认 GAME+LOGIN+CHAT 未因管理后台部署而重启或改变协议；做好 DB/资源/后台备份与回退，并验证本机端口 `127.0.0.1:8081`。
5. **只允许 SSH 隧道/VPN/经身份验证的 HTTPS 反向代理访问**；不得裸露 `8081`、`5432` 到公网，口令绝不通过聊天或 GitHub 发布。
6. 正式上线应由有权限的运维通道现场执行并获得真实健康证据。QA 分支与 Actions 绿灯不能代表已上线。

## 保留事项

未调查服务器上的 crontab、systemd、Java 运行时二进制、第三方 JAR、数据库触发器/函数、所有历史管理员日志，以及实际防火墙开放范围。因此无法作出“完全无后门”的结论。
