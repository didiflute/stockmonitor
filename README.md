# TQQQ 网格交易信号系统

自动追踪 TQQQ 价格，按你的网格交易模型评估买/卖信号，触发就通过邮件/微信/短信提醒你和老公。配套一个手机网页 dashboard，"添加到主屏幕"后跟原生 App 一样用。

## 系统架构

```
Yahoo Finance → GitHub Actions (每 5 分钟，仅美股盘中)
   → Python 评估信号 → 触发就发通知
   → state.json 写回 GitHub repo
   → Dashboard (Cloudflare Pages) 实时读取
```

**月成本**：免费（不开 Twilio 短信的话）。GitHub Actions 每月 2000 分钟免费，我们用约 800 分钟。

## 项目结构

```
tqqq-grid/
├── src/
│   ├── grid_signal.py    # 信号逻辑（已用 xlsx 回测验证）
│   ├── price.py          # 价格获取（Yahoo + Finnhub 备源）
│   ├── notify.py         # 邮件 + 微信 + 短信
│   ├── state.py          # 状态读写
│   └── main.py           # 入口（GitHub Actions 跑这个）
├── tests/
│   ├── test_against_xlsx.py    # 跟你 xlsx 模型完全对齐
│   └── test_integration.py     # 8 项集成测试
├── dashboard/
│   ├── index.html        # PWA 仪表板
│   ├── app.js
│   ├── manifest.json
│   └── icon.svg
├── .github/workflows/
│   └── check_signal.yml  # 每 5 分钟跑一次
├── config.yaml           # 你的配置（信号类型、阈值、金额、收件人）
├── state.json            # 当前状态（脚本自动维护）
└── requirements.txt
```

## 部署步骤（一次性，约 30 分钟）

### 第 1 步：创建 GitHub 仓库

1. 在 [github.com](https://github.com/new) 新建一个 **私有** 仓库，名字随意（推荐 `tqqq-grid`）。
2. 把这整个 `tqqq-grid` 文件夹的内容上传到仓库根目录。
3. 编辑 `dashboard/app.js`，把开头的：
   ```js
   const GITHUB_USER = "YOUR_GITHUB_USERNAME";
   const GITHUB_REPO = "tqqq-grid";
   ```
   改成你自己的用户名和仓库名。

### 第 2 步：配置 Pushover（手机推送，主通道）

每人都要做一遍：

1. 注册账号：https://pushover.net/signup
2. App Store 搜 **Pushover**，付 $4.99 买下、安装、登录。
3. 登录 https://pushover.net 后，**Your User Key** 显示在主页右上（30 位字符串）。复制下来——这就是你的 `USER_KEY`。
4. 老公那边重复 1-3，拿到他的 `USER_KEY`。

然后**创建一个 Application**：
1. 登录后 → 拉到底 → 点 "Create an Application/API Token"。
2. Name 填 "TQQQ Signal"，描述随便写，图标可不传。
3. 创建后会拿到一个 **API Token/Key**（30 位）。复制下来——这是 `API_TOKEN`，所有人共用。

### 第 3 步：（可选）配置 Gmail 应用专用密码作为邮件备份

万一 Pushover 没收到，邮箱里也有底。**不想做也可以跳过**，纯靠 Pushover 也够用。

1. 登录 Gmail，确保已经开启了 2-Step Verification（https://myaccount.google.com/signinoptions/twosv）
2. 打开 https://myaccount.google.com/apppasswords
3. 生成一个 16 位"应用专用密码"（用途填 "TQQQ Signal"）。
4. 复制这个密码（只显示一次，丢了就重新生成）。

> 注意：这跟 Gmail 登录密码不一样。如果 App Passwords 页面显示 "not available"，需要先添加 Authenticator app（见 https://myaccount.google.com/security ）。

### 第 4 步：在 GitHub 仓库配置 Secrets

仓库页面 → Settings → Secrets and variables → Actions → New repository secret

| Secret 名 | 值 |
|----------|---|
| `PUSHOVER_API_TOKEN` | 第 2 步创建 App 后拿的 API Token |
| `PUSHOVER_USER_WENDI` | 你的 User Key |
| `PUSHOVER_USER_HUSBAND` | 老公的 User Key |

如果做了第 3 步，再加：
| `GMAIL_USER` | 你的 gmail 地址（例 `wendizeng11@gmail.com`） |
| `GMAIL_APP_PASSWORD` | 16 位应用专用密码（去掉空格） |

可选：
| `FINNHUB_API_KEY` | Yahoo 偶尔抽风时的备源（finnhub.io 免费注册） |

### 第 5 步：检查 config.yaml

`config.yaml` 已经填好了你和老公的邮箱、Pushover 收件人。检查一下 `notifications` 段：

```yaml
notifications:
  pushover:
    enabled: true
    recipients:
      - wendi
      - husband
  email:
    enabled: true
    to:
      - wendizeng11@gmail.com
      - pengfukang@gmail.com
```

如果不想要邮件备份，把 `email.enabled` 改成 `false` 即可。改完 commit push 到 GitHub。

### 第 6 步：启用 GitHub Actions

1. 仓库 → Actions Tab → "I understand my workflows, go ahead and enable them"
2. 找到 "TQQQ Signal Check" workflow → 点 "Run workflow" 手动触发一次。
3. 等 1-2 分钟，看运行日志（绿色 ✓ = 成功）。
4. 检查仓库根目录是否多了一个 `state.json` 文件（有就说明端到端跑通了）。

### 第 7 步：部署 Dashboard 到 Cloudflare Pages

1. 注册 [Cloudflare](https://dash.cloudflare.com)（免费）。
2. Workers & Pages → Create application → Pages → Connect to Git。
3. 选你刚才的仓库。
4. 构建设置：
   - Framework preset: **None**
   - Build command: 留空
   - Build output directory: `dashboard`
5. 部署。1-2 分钟后会得到一个 `xxx.pages.dev` 的网址。

### 第 8 步：手机上"添加到主屏幕"

iPhone:
1. Safari 打开 `xxx.pages.dev`
2. 分享按钮 → 添加到主屏幕

Android (Chrome):
1. 打开网址，菜单 → "添加到主屏幕"

之后桌面就有个 TQQQ 图标，点开像 App 一样全屏运行。

---

## 日常使用

**改信号类型 / 阈值 / 金额**：
- 直接在 GitHub 网页上编辑 `config.yaml`，commit 后下次脚本运行就用新配置。
- 或者本地编辑后 push。

**手动测试**：
- 仓库 Actions → Run workflow，立即跑一次。

**查看历史日志**：
- Actions → 点开任一次运行，看到完整日志。

**触发信号收到通知**：
- iPhone Pushover App 弹出推送（cashregister 音效，听着像收钱声）
- 邮箱里也会收到一封（备份，万一 Pushover 没收到）
- Dashboard 顶部出现警告卡片

---

## 验证一切就绪

```bash
# 本地跑测试
cd tqqq-grid
pip install -r requirements.txt
python tests/test_integration.py
python tests/test_against_xlsx.py
```

应该看到：
- `集成测试: 全部 8 个测试通过`
- `DAILY/WEEKLY/MONTHLY 信号 不一致条目: 0`

---

## FAQ

**Q: 价格延迟多少？**
Yahoo Finance 免费数据延迟 1-2 分钟。GitHub Actions cron 每 5 分钟跑一次，可能再延迟 0-15 分钟。所以触发到通知最长 ~20 分钟。

**Q: 周末/节假日怎么办？**
脚本会判断美股盘中（工作日 9:30-16:00 ET），盘外直接跳过、不发通知。

**Q: 为什么"我已下单"按钮在 Dashboard 上不持久？**
v1 dashboard 是只读的（直接读 state.json），目前只能展示后端记录的状态。如果想让按钮真正生效，需要再加一个简单的 Cloudflare Worker 接收点击 → 改 state.json → push。这是 v2 的事情。

**Q: 同一个信号会重复通知吗？**
不会。脚本按"日期 + 信号类型 + 动作"去重，同一天同一种信号同一动作只通知一次。第二天会重新评估。

**Q: 怎么改提醒频率？**
改 `.github/workflows/check_signal.yml` 里的 cron 表达式。默认 `*/5` 是每 5 分钟。

**Q: GitHub Actions 免费额度够用吗？**
够。预估每月用 800 分钟（每月 21 个交易日 × 6.5 小时 × 12 次/小时 × 30 秒/次），免费额度 2000 分钟。

---

## 出问题怎么办

1. **没收到 Pushover 推送** → Actions 日志看 `通知结果:` 那行。`{"pushover": {"wendi": True/False, ...}, "email": ...}`，false 的就是没成功。常见原因：USER_KEY 抄错了、Pushover App 还没付费激活、API_TOKEN 配错。
2. **没收到邮件** → 检查 GMAIL_USER / GMAIL_APP_PASSWORD 是否在 GitHub Secrets 里、密码是否复制时漏了字符（应用专用密码是 16 位，无空格）；也看下垃圾邮件文件夹。
3. **价格拉不到** → Yahoo 偶尔限流。注册 Finnhub 免费 API 加个备源（`FINNHUB_API_KEY` secret）。
4. **state.json 没更新** → 看 Actions 日志倒数几行，可能 git push 权限不够（确保 workflow 的 `permissions: contents: write` 在）。
