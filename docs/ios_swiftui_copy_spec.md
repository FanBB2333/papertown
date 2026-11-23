# Papertown iOS · Page-by-Page Copy Specification (English-First, `zh-Hans` Optional)

This specification defines **English (`en`) as the primary UI & development language** (`defaultLocalization: "en"` in [ios/Package.swift](../ios/Package.swift)), with **Simplified Chinese (`zh-Hans`) as an optional secondary language** selectable via system locale or in-app settings. All domain terms align with [web/src/i18n/en.json](../web/src/i18n/en.json), [server/papertown/pipeline.py](../server/papertown/pipeline.py), [web/src/components/Resident.tsx](../web/src/components/Resident.tsx), and [web/src/agents/Compose.tsx](../web/src/agents/Compose.tsx).

---

## 1. Global Copy & Apple HIG Casing Rules

- **Zero Emojis**: 100% SF Symbols + concise text labels + iOS semantic colors.
- **English Casing (Apple HIG)**:
  - **Title Case**: Navigation titles (`Inbox`, `Projects`, `Staff`, `Server`), Tab labels, Button labels (`Allow`, `Deny`, `Reply`, `Connect Server`).
  - **Sentence case**: Section footers, alert body copy, placeholders, empty-state descriptions, status explanations.
  - **Short labels for narrow widths**: Segmented controls (`Picker(.segmented)`) and Tab items stay 1–2 short words so nothing clips on 375pt screens (e.g., `Steer` / `Queue` / `Interrupt`, `All` / `Needs You` / `Active` / `Done`).
- **Typography & Truncation**:
  - Project list titles: `#{seq} {title}` with `.lineLimit(2)` and trailing ellipsis.
  - Inline navigation bar: Title `#{seq}`, Subtitle `{Stage Name}` (avoids truncating long paper titles in a single-line nav bar).
  - Message previews in lists: Strip Markdown (`**`, `__`, `` ` ``, `#`) before display; render rich Markdown only inside chat bubbles.

### Canonical Domain Dictionary (`en` Primary / `zh-Hans` Optional)

| Domain | Server Value | English (Primary) | 简体中文 (Optional) |
|---|---|---|---|
| **Agent Roles** | `lead` / `coder` / `writer` / `monitor` / `assistant` | `Project Lead` / `Coding Agent` / `Writing Agent` / `Field Watcher` / `Assistant` | `项目负责人` / `代码员工` / `写作员工` / `看田员` / `小助手` |
| **8 Stages** | `idea` / `hatch` / `team` / `method` / `exp` / `write` / `review` / `ship` | `Idea` / `Overlap Check` / `Team Up` / `Method Design` / `Experiments` / `Write & Typeset` / `Review` / `Ship` | `灵感` / `查重孵化` / `立项编队` / `方法设计` / `实验` / `写作排版` / `质检` / `出厂投稿` |
| **Stage Status** | `done` / `run` / `todo` | `Done` / `Running` / `Not Started` | `完成` / `进行中` / `尚未开始` |
| **Lead State** | `running` / `starting` / `blocked` / `off` / `ended` | `On Duty` / `Starting` / `Blocked` / `Paused` / `Ended` | `在岗` / `启动中` / `受阻` / `暂停` / `结束` |
| **Staff Buckets** | `needs` / `failed` / `review` / `working` / `idle` / `off` | `Needs You` / `Failed` / `Unread` / `Working` / `Idle` / `Off` (`Offline` if down) | `待处理` / `出错` / `待查看` / `工作中` / `待命` / `未启动`（`连不上`） |
| **Project Health** | `ok` / `risk` / `blocked` | `On Track` / `At Risk` / `Blocked` | `正常` / `有风险` / `受阻` |
| **Delivery Mode** | `steer` / `queue` / `interrupt` | `Steer` / `Queue` / `Interrupt` | `插话` / `排队` / `中断` |

---

## 2. Tab Bar & Root Navigation

| Slot | Tab 1 | Tab 2 | Tab 3 | Tab 4 |
|---|---|---|---|---|
| **Tab Label (`en`)** | `Inbox` | `Projects` | `Staff` | `Server` |
| **Tab Label (`zh-Hans`)** | `待处理` | `项目` | `员工` | `服务器` |
| **Large Title (`en`)** | `Inbox` | `Projects` | `Staff` | `Server` |
| **Top Trailing Action** | Connection status pill (`{Server Name}` / `Reconnecting…` / `Sign In` / `Disconnected`) | `+` (`New Idea`) | Sort menu (`Sort by Urgency` / `Group by Project`) | `+` (`Add Server`) |

---

## 3. Page-by-Page Copy Matrix

### Screen 0: Connect / Edit Server Sheet (`ConnectionSheet`)

| Element | English (Primary) | 简体中文 (Optional) |
|---|---|---|
| **Nav Bar** | `Cancel` · `Connect Server` (`Edit Server`) · `Connect` | `取消` · `连接服务器`（`编辑服务器`） · `连接` |
| **Section 1 Header** | `Server Address` | `服务器地址` |
| **Field · Name** | Label: `Name` · Placeholder: `e.g., Home Mac` | `名称` · `例如：家里 Mac` |
| **Field · URL** | Label: `URL` · Placeholder: `https://example.com or http://192.168.1.10:8000` | `根地址` · `https://example.com 或 http://192.168.1.10:8000` |
| **Section 1 Footer** | `Enter the root URL of your Mac or self-hosted relay. Path prefixes are supported; /api is appended automatically. For direct LAN access, keep both devices on the same network.` | `填写电脑或自建中转的根地址，可包含路径前缀；客户端会自动追加 /api。局域网直连请确保手机与电脑在同一网络。` |
| **Section 2 Header** | `Authentication` | `访问鉴权` |
| **Field · Password** | Label: `Password` · Placeholder: `Optional on local network` | `访问密码` · `局域网免密可留空` |
| **Toggle · Auto Sign-In** | `Auto Sign-In with Face ID` (`Touch ID` fallback) | `使用面容 ID 自动续登`（`触控 ID`） |
| **Section 2 Footer** | `Sessions stay in memory only. When enabled, your password is stored in the iOS Keychain so Papertown can sign in again after relaunch.` | `登录会话仅保存在内存中。开启后会在本机钥匙串安全保存访问密码，重启 App 时自动重新登录。` |

### Screen 0.5: Sign-In Sheet (`LoginSheet`)

| Element | English (Primary) | 简体中文 (Optional) |
|---|---|---|
| **Title** | `Sign In Required` (on 401 expiry: `Session Expired`) | `需要登录`（`登录已过期`） |
| **Subtitle** | First time: `Connecting to “%@” (%@). Enter the password configured in desktop Settings › Access & Sign-In.`<br>Expired: `Your session on “%@” has expired. Sign in again to resume live updates.` | `正在连接「%@」（%@），请输入桌面端「设置 › 访问与登录」中配置的密码。`<br>`与「%@」的会话已失效，请重新输入密码以继续同步。` |
| **Password Field** | `Access password` | `输入访问密码` |
| **Primary / Secondary** | `Sign In` (`Signing In…`) / `Switch Server` | `登录`（`正在验证…`） / `切换服务器` |
| **Wrong Password (401)** | `Incorrect password. Please try again.` | `密码不正确，请重试。` |

### Screen 1: Inbox (`InboxView` · Tab 1)

| Element | English (Primary) | 简体中文 (Optional) |
|---|---|---|
| **Section 1 Header** | `Needs Your Attention` | `需要你处理` |
| **Card Actions** | Ask: `Reply` · `Open Project`<br>Permission: `Allow` · `Deny` · `View Chat`<br>Blocked Lead: `Retry` · `Open Project` | 提问：`去回复` · `查看项目`<br>权限：`允许` · `拒绝` · `查看对话`<br>受阻：`重试` · `查看项目` |
| **Section 1 Empty State** | `All Caught Up` — `No decisions, approvals, or blocked gates need your attention right now.` | `暂无待处理事项` — `当前没有等待审批、决策或被卡口阻断的事项。` |
| **Section 2 Header** | `Active Projects` | `进行中的项目` |
| **Global Empty State** | `No Projects Yet` — `Drop in a new research idea in Projects, or link an existing repository on your Mac.` | `还没有项目` — `前往「项目」页新建一个研究 idea，或在电脑端接入已有仓库。` |
| **Connection Banner** | Reconnecting: `Connection to “%@” interrupted. Reconnecting…`<br>Offline: `Unable to reach “%@”. Showing last synced state.` | `与「%@」的连接已中断，正在重连…`<br>`无法连接到「%@」，当前显示上次同步内容。` |

### Screen 2: Projects (`ProjectsView` · Tab 2) & New Idea (`NewIdeaSheet`)

| Element | English (Primary) | 简体中文 (Optional) |
|---|---|---|
| **Search Prompt** | `Search projects, numbers, or stages` | `搜索项目标题、编号或阶段` |
| **Filter Picker** | `All` · `Needs You` · `Active` · `Done` | `全部` · `待处理` · `进行中` · `已完成` |
| **New Idea Sheet** | Title: `New Idea` · Section: `Research Idea`<br>Placeholder: `Describe your research idea, problem statement, or core hypothesis…`<br>Footer: `Creates the project immediately and starts its Project Lead to run an overlap check.` | `新建 Idea` · `研究想法`<br>`描述你的研究 idea、想解决的问题或核心假设…`<br>`提交后会立即创建项目并启动负责人，由其先完成查重孵化并向你汇报撞车报告。` |

### Screen 3: Project Detail (`ProjectDetailView`)

| Element | English (Primary) | 简体中文 (Optional) |
|---|---|---|
| **Inline Nav Bar** | Title: `#{seq}` · Subtitle: `{Stage Name}` | 主标：`#{seq}` · 副标：`{阶段名}` |
| **Resident Lead Copy** | `running`: `{runtime} · {model} · Working/Idle`<br>`starting`: `Starting up. Sending the project brief as its first message.`<br>`blocked`: `{resident.note ?? "Failed to start the project lead."}`<br>`off`: `Paused. Turn the switch on to resume the same conversation.`<br>`off` (sample): `Sample project with placeholder content. Turn the switch on to hand it to a real lead.`<br>`ended`: `This project has ended. The lead is no longer resident.` | 对齐 `Resident.tsx` 6 态中文说明 |
| **Section Headers** | `Project Lead` · `Research Progress` · `Team` · `Recent Activity` | `项目负责人` · `研究进度` · `团队成员` · `最近动态` |
| **Primary CTA** | `Message Project Lead` | `与项目负责人对话` |

### Screen 4: Staff (`StaffView` · Tab 3)

| Element | English (Primary) | 简体中文 (Optional) |
|---|---|---|
| **Search Prompt** | `Search staff, projects, or tasks` | `搜索员工、项目或任务` |
| **Sort Menu** | `Sort by Urgency` · `Group by Project` | `按紧急程度` · `按项目分组` |
| **Pinned Section** | `Town` → `Assistant` (`Cross-project status, actions, and new ideas`) | `全局` → `小助手`（`跨项目查询、调度与新建 Idea`） |
| **Relative Time** | `Just now` · `%dm ago` · `%dh ago` · `%dd ago` | `刚刚` · `%d 分钟前` · `%d 小时前` · `%d 天前` |

### Screen 5: Agent Chat (`AgentChatView`)

| Element | English (Primary) | 简体中文 (Optional) |
|---|---|---|
| **Empty Chat** | `No Messages Yet` — `Send a message below to start a new turn.` | `还没有对话` — `发送一条消息即可开始新一轮任务。` |
| **Queued Bar** | `Queued` · `Send Now` · `Withdraw` | `已排队` · `立即发送` · `撤回` |
| **Permission Warning** | `Steering declines the pending permission prompt before sending. Use Allow or Deny on the prompt first.` | `插话会先拒绝当前权限请求，再发送消息。请优先使用权限卡片上的「允许」或「拒绝」。` |
| **Composer States** | Idle: `Message %@ to start a new turn…`<br>Offline: `Agent is paused. Start it from the project page.`<br>Working (`Steer` / `Queue` / `Interrupt`):<br>• `Steer`: `Add instructions to the current turn…` / `Joins the current turn after the active step completes.`<br>• `Queue`: `Schedule a message for the next turn…` / `Sent automatically once the current turn finishes.`<br>• `Interrupt`: `Stop current work and send new instructions…` / `Stops the running turn and sends immediately.` | 对齐 `Compose.tsx` 中文文案 |
| **Uncertain Delivery Alert** | Title: `Delivery Status Unknown`<br>Message: `The connection dropped while sending. Refresh history first to check whether the server received your message before resending.`<br>Actions: `Refresh History` · `Send Again` · `Cancel` | `无法确认消息是否送达`<br>`发送过程中连接中断，建议先刷新历史记录确认，避免重复发送。`<br>`刷新历史` · `仍要重发` · `取消` |

### Screen 6: Server & Settings (`ServerView` · Tab 4)

| Element | English (Primary) | 简体中文 (Optional) |
|---|---|---|
| **Current Connection** | `Live Feed` · `Route` · `Session` · `Address`<br>Footer: `Live updates pause automatically in the background to save battery and resync when you return.` | `实时通道` · `连接方式` · `鉴权状态` · `服务地址` |
| **Preferences** | `Appearance` (`System` / `Light` / `Dark` / `Paper`)<br>`Language` (`English` / `简体中文` / `System Default`) | `外观` / `界面语言` |
| **Sign Out Dialog** | `Sign Out of This Server?` — `This closes the live stream and clears your session on this device. You will need to sign in again next time.` | `确定要注销当前会话吗？` — `将断开实时通道并清除本机登录状态，下次连接需重新验证密码。` |

---

## 4. `Info.plist` & Error Translation

### `Info.plist` Permission Strings
- **`NSLocalNetworkUsageDescription`**: `Papertown uses the local network to connect directly to the Papertown server running on your computer.`
- **`NSFaceIDUsageDescription`**: `Papertown uses Face ID to unlock your saved server password in Keychain for automatic sign-in.`

### Error Mapping (`TextFormatters.errorMessage`)

| Error | English (Primary) | 简体中文 (Optional) |
|---|---|---|
| `ClientError.invalidAddress` | `Invalid server address. Use a full http:// or https:// URL without query parameters or embedded credentials.` | `服务器地址格式不正确，请使用 http:// 或 https:// 完整地址，不要包含查询参数或账号密码。` |
| `ClientError.invalidResponse` | `The server returned an unexpected response or redirect. Enter the final HTTPS address directly.` | `服务器返回了异常响应或重定向，请直接填写最终 HTTPS 地址。` |
| `ClientError.http(401)` | `Session expired or password invalid. Please sign in again.` | `登录已过期或密码无效，请重新登录。` |
| `ClientError.http(403)` | `Access denied by server. Check your proxy forwarding headers or access rules.` | `服务端拒绝了本次请求，请确认访问权限或代理转发头配置。` |
| `ClientError.http(404)` | `This project or agent could not be found on the server.` | `服务端未找到对应项目或员工，可能已被移除。` |
| `ClientError.http(502/503/504)` | `The relay cannot reach your Mac right now. Make sure Papertown is running on your computer.` | `中转服务暂时无法连到你的电脑，请确认电脑端 Papertown 正在运行。` |
| `URLError.notConnectedToInternet` | `No internet connection. Check Wi-Fi or cellular data and try again.` | `当前设备未连接网络，请检查 Wi-Fi 或蜂窝网络。` |
| `URLError.cannotConnectToHost` / `.timedOut` | `Could not reach the server. For LAN direct access, verify both devices share the same Wi-Fi and Local Network access is allowed.` | `连接超时，无法访问目标服务器。局域网直连请确认与电脑在同一 Wi-Fi 且已允许本地网络权限。` |
| `URLError.appTransportSecurityRequiresSecureConnection` | `iOS blocked an unencrypted HTTP connection. Use HTTPS or configure local network ATS access.` | `iOS 阻止了非加密 HTTP 连接，请改用 HTTPS 或检查本地网络配置。` |

---

## 5. Localization Files in the Repository

- English source catalog: [ios/Sources/PapertownUI/Resources/en.lproj/Localizable.strings](../ios/Sources/PapertownUI/Resources/en.lproj/Localizable.strings)
- Simplified Chinese catalog: [ios/Sources/PapertownUI/Resources/zh-Hans.lproj/Localizable.strings](../ios/Sources/PapertownUI/Resources/zh-Hans.lproj/Localizable.strings)
- Runtime loader & formatters: [Localization.swift](../ios/Sources/PapertownUI/Support/Localization.swift), [TextFormatters.swift](../ios/Sources/PapertownUI/Support/TextFormatters.swift)
