import Foundation

// What the app itself says (menus, the splash, the page's dialogs), in the language the page is
// shown in (web/src/i18n.ts). Keyed by the Simplified Chinese, like the page's own dictionary;
// {0} is the argument.
enum Lang: String {
    case en, hans = "zh-Hans", hant = "zh-Hant"

    // what the page starts in on this Mac, before anyone picks one in its settings
    static var system: Lang {
        let first = Locale.preferredLanguages.first ?? "en"
        if !first.hasPrefix("zh") { return .en }
        return first.contains("Hant") || first.hasSuffix("TW") || first.hasSuffix("HK") || first.hasSuffix("MO") ? .hant : .hans
    }
}

private let words: [String: (en: String, hant: String)] = [
    // menus
    "设置…": ("Settings…", "設定…"),
    "App 设置…": ("App Settings…", "App 設定…"),
    "在浏览器中打开": ("Open in Browser", "在瀏覽器中開啟"),
    "中控屏": ("Console", "中控屏"),
    "小镇": ("Town", "小鎮"),
    "运行状态": ("Status", "運行狀態"),
    "重新载入": ("Reload", "重新載入"),
    "实际大小": ("Actual Size", "實際大小"),
    "放大": ("Zoom In", "放大"),
    "缩小": ("Zoom Out", "縮小"),
    "服务": ("Server", "服務"),
    "重新构建网页": ("Rebuild the Page", "重新建構網頁"),
    "网页代码改动后自动构建": ("Rebuild When the Web Code Changes", "網頁程式碼改動後自動建構"),
    "重启服务": ("Restart the Server", "重啟服務"),
    "显示服务日志": ("Show Server Log", "顯示服務日誌"),
    "显示构建日志": ("Show Build Log", "顯示建構日誌"),
    // the page's dialogs
    "好": ("OK", "好"),
    "取消": ("Cancel", "取消"),
    // starting up
    "正在启动服务…": ("Starting the server…", "正在啟動服務…"),
    "正在安装网页的依赖…": ("Installing the page's packages…", "正在安裝網頁的依賴…"),
    "正在构建网页…": ("Building the page…", "正在建構網頁…"),
    "正在打开…": ("Opening…", "正在開啟…"),
    "找不到 Papertown 的代码：{0}": ("Can't find Papertown's code at {0}", "找不到 Papertown 的程式碼：{0}"),
    "端口 {0} 被别的程序占用了": ("Port {0} is taken by another program", "連接埠 {0} 被別的程式佔用了"),
    "服务没能启动": ("The server didn't start", "服務沒能啟動"),
    "网页还没构建过，这次构建也失败了": ("The page has never been built, and building it failed", "網頁還沒建構過，這次建構也失敗了"),
    "服务在运行，但没有托管网页：它启动时 web/dist 还不存在，重启它就好": (
        "The server is running but not serving the page: web/dist didn't exist when it started. Restart it.",
        "服務在運行，但沒有託管網頁：它啟動時 web/dist 還不存在，重啟它就好"),
    "页面打不开：{0}": ("The page didn't open: {0}", "頁面打不開：{0}"),
    "重试": ("Try Again", "重試"),
    "显示日志": ("Show Log", "顯示日誌"),
    // over the page (its own toasts)
    "已下载 {0}，在「下载」文件夹里": ("Downloaded {0} to your Downloads folder", "已下載 {0}，在「下載」資料夾裡"),
    "下载失败：{0}": ("Download failed: {0}", "下載失敗：{0}"),
    "网页构建失败，详见「服务」菜单里的构建日志": ("Building the page failed; the build log is in the Server menu", "網頁建構失敗，詳見「服務」選單裡的建構日誌"),
    "网页有更新，按 ⌘R 重新载入": ("The page has been updated: press ⌘R to reload", "網頁有更新，按 ⌘R 重新載入"),
    "服务退出了，可以在「服务」菜单里重启": ("The server stopped; restart it from the Server menu", "服務退出了，可以在「服務」選單裡重啟"),
    // the app's settings
    "Papertown 的代码": ("Papertown's code", "Papertown 的程式碼"),
    "选择…": ("Choose…", "選擇…"),
    "端口": ("Port", "連接埠"),
    "启动服务的命令": ("Command that starts the server", "啟動服務的命令"),
    "在代码的 server 目录里、用登录 shell 的环境运行；$PAPERTOWN_PORT 是上面的端口。端口上已经有 Papertown 在跑时，App 直接用它。": (
        "Run in the code's server folder with your login shell's environment; $PAPERTOWN_PORT is the port above. When Papertown is already running on that port, the app uses it.",
        "在程式碼的 server 目錄裡、用登入 shell 的環境執行；$PAPERTOWN_PORT 是上面的連接埠。連接埠上已經有 Papertown 在跑時，App 直接用它。"),
    "退出 App 时停止它启动的服务": ("Stop the server the app started when quitting", "結束 App 時停止它啟動的服務"),
    "恢复默认": ("Restore Defaults", "恢復預設"),
    "改了代码位置、端口或命令，重启服务后生效": ("Changes to the code, port or command apply when the server restarts", "改了程式碼位置、連接埠或命令，重啟服務後生效"),
    "服务不是这个 App 启动的：在启动它的地方重启": ("This app didn't start the server: restart it where it was started", "服務不是這個 App 啟動的：在啟動它的地方重啟"),
]

@MainActor
func t(_ s: String, _ args: CVarArg...) -> String {
    let lang = Shell.shared.lang
    let w = lang == .hans ? s : words[s].map { lang == .en ? $0.en : $0.hant } ?? s
    return args.enumerated().reduce(w) { $0.replacingOccurrences(of: "{\($1.offset)}", with: "\($1.element)") }
}
