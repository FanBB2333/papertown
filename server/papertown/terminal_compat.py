"""Papertown's terminal identities, launcher and presentation strings."""
import sys
from functools import partial

from teletty import HeadlessBackend, Herdr, HerdrBackend, Messages, TmuxBackend
from teletty.backends import binary as find_binary

TERM_NAME = "Papertown"
EXIT_NOTE = "[进程已退出，退出码 {code}]"
binary = partial(find_binary, exclude=(".app/", "cmux-cli-shims"))

MESSAGES = Messages({
    "bad_keys": "不支持这个按键",
    "bad_key": "不支持的按键：{key}",
    "terminal_exited": "终端会话已退出",
    "typing_unsupported": "这个终端不接受直接输入",
    "stale_prompt": "终端画面已变化，请重新查看。",
    "bad_option": "所选选项超出有效范围。",
    "tmux_missing": "本机没有找到 tmux",
    "tmux_launch_failed": "tmux 启动失败：{error}",
    "tmux_failed": "tmux 操作失败：{error}",
    "tmux_close_failed": "{error}",
    "tmux_exec_failed": "{error}",
    "tmux_invalid": "{error}",
    "pty_unavailable": "本系统不支持伪终端",
    "daemon_stopped": "后台终端服务未运行",
    "daemon_unreachable": "后台终端服务无响应：{error}",
    "daemon_invalid": "后台终端服务返回了无效数据",
    "daemon_failed": "后台终端操作失败",
    "daemon_start": "后台终端服务无法启动，详见 {path}",
    "daemon_exec_failed": "{error}",
    "launch_failed": "Papertown 无法启动 {executable}：{error}",
    "decode_failed": "[无法解码终端输出]",
    "unknown_operation": "没有这种操作：{op}",
    "herdr_invalid": "herdr 返回了无效数据",
    "herdr_disconnected": "herdr 连接已断开",
    "herdr_overflow": "herdr 返回的数据过长",
    "herdr_disabled": "herdr 接入已关闭",
    "herdr_unavailable": "herdr 没有运行",
    "herdr_failed": "herdr 未能完成操作（{host_code}），请查看终端状态",
    "herdr_unknown_code": "未知错误",
    "agent_blocked": "它在等你处理终端里的对话框",
    "agent_not_found": "没有这个终端会话",
    "pane_not_found": "没有这个终端会话",
    "agent_not_ready": "终端里的 agent 尚未就绪",
    "timeout": "herdr 响应超时，请查看终端状态",
})


def herdr_client(settings):
    return Herdr(settings.herdr_socket, enabled=settings.herdr, messages=MESSAGES)


def tmux_backend(executable, settings):
    conf = settings.data_dir / "tmux.conf"
    if executable and not conf.exists():
        user_config = "source-file -q ~/.tmux.conf\n" if settings.tmux_socket == "papertown" else ""
        conf.write_text(user_config + "set -g extended-keys on\nset -g extended-keys-format csi-u\n", encoding="utf-8")
    return TmuxBackend(executable, settings.tmux_socket, identity_option="@papertown_id", config=conf,
                       buffer_prefix="pt-", messages=MESSAGES, attach_executable="tmux")


def transports(agents):
    s = agents.s
    return {
        "tmux": agents.tmux_host,
        "herdr": HerdrBackend(herdr_client(s), s.terminal_startup),
        "headless": HeadlessBackend(s.data_dir, namespace="papertown", daemon=(sys.executable, "-m", "papertown.ptyd"),
                                    daemon_args=("--term-name", TERM_NAME, "--exit-note", EXIT_NOTE), messages=MESSAGES),
    }
