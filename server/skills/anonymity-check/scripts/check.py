"""Submission format check. Deterministic rules; see SKILL.md.

stdin:  {"tex": str, "pages": int | null, "page_limit": int, "cited": int}
stdout: {"issues": [{"rule": str, "blocking": bool, "detail": str}], "ok": bool, "summary": str}
"""

import json
import re
import sys

a = json.load(sys.stdin)
tex = a.get("tex") or ""
issues = []


def add(rule, blocking, detail):
    issues.append({"rule": rule, "blocking": blocking, "detail": detail})


m = re.search(r"\\author\{([^}]*)\}", tex)
if m and "anonymous" not in m.group(1).lower():
    add("匿名", True, f"\\author 不是匿名：{m.group(1)[:60]}")
for e in sorted(set(re.findall(r"[\w.+-]+@[\w-]+\.[\w.]+", tex)))[:3]:
    add("匿名", True, f"出现邮箱 {e}")
if "\\thanks" in tex:
    add("匿名", True, "出现 \\thanks")
if re.search(r"\\section\*?\{acknowledg", tex, re.I):
    add("匿名", True, "审稿版不能有致谢")
for link in sorted(set(re.findall(r"(?:github|gitlab|huggingface)\.co[m]?/[\w./-]+", tex)))[:3]:
    add("匿名", True, f"出现仓库链接 {link}")

pages, limit = a.get("pages"), int(a.get("page_limit") or 9)
if pages is None:
    add("编译", True, "没有 PDF，可能是编译失败")
elif pages > limit:
    add("页数", True, f"{pages} 页，超过 {limit} 页限制")
if int(a.get("cited") or 0) < 5:
    add("引用", False, f"只引用了 {a.get('cited') or 0} 篇，related work 偏薄")

blocking = [i for i in issues if i["blocking"]]
print(json.dumps({"issues": issues, "ok": not blocking,
                  "summary": "格式通过" if not issues else f"{len(blocking)} 处硬伤，{len(issues) - len(blocking)} 条提示"},
                 ensure_ascii=False))
