# skills/

可移植的技能包，用来把这个项目里已经跑通的能力交给别的 AI。

每个技能是一个目录，里面一个 `SKILL.md`（带 YAML frontmatter：`name` + `description`）加可选的 `references/`。这个格式 Claude Code、Codex、Gemini CLI 都认，所以一份内容装到哪家都能用。

## 安装

```bash
node skills/install.mjs --list     # 先看会装到哪儿
node skills/install.mjs            # 装到所有检测到的 AI
node skills/install.mjs claude     # 只装某一家：claude / codex / gemini
node skills/install.mjs --skill unzoo-fanqie-publish
```

覆盖安装（先删旧目录），装完新开一个会话生效。

手动装也行，直接把技能目录拷到：

| AI | 目录 |
|---|---|
| Claude Code | `~/.claude/skills/<技能名>/` |
| Codex | `~/.codex/skills/<技能名>/` |
| Gemini CLI | `~/.gemini/skills/<技能名>/` |

## 现有技能

### `unzoo-fanqie-publish`

用 Unzoo 浏览器把章节发到番茄小说作者后台。内容全部来自 `src/fanqie.mjs` 里已经在生产跑通的实现——两个传输层怎么分工、按账号锁标签页怎么防发错号、番茄编辑器为什么必须用可信键盘"敲一下"才能启用「下一步」、封面上传唯一走得通的那个 REST 端点，以及一张按现象索引的坑表。

给别的 AI 装上之后，它不用重新趟一遍这些坑。
