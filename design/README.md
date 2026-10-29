# Papertown 设计方案

两个页面都是单文件、完全离线，双击就能打开，不依赖任何 CDN。

- `prototype.html`：选定方案的可交互原型（A 全景小镇 + 纸艺）。
- `index.html`：方案对比页，四种布局 × 四种风格，留作探索记录。

## 原型（prototype.html）

- **世界**（主界面）：整屏世界地图，拖动平移、滚轮缩放，右下角小地图可以点击跳转。右上角「进行中」列出正在跑的流水线。
- **点建筑**：弹出这座建筑的流水线（C 布局的工位排列），下面三栏是当前工位、进货 / 出货、现实里对应的工具。造纸厂展示一篇论文从灵感到出港的 8 道工序，点工序会跳到它所在的建筑。
- **对话**：HUD 的「对话」、左下角「放入一颗新 idea」、建筑详情里的「问问这里的员工」都会从右侧滑出 B 布局的工作台（对话 / 流水线 / 调用轨迹）。发送消息会得到一条预设回复。
- **运行状态**：HUD 上的切换开关，和「世界」同级。用 D 布局的日报版式，只用平实的名字（项目、新论文、GPU），不出现世界设定。点底部的世界日报滚动条也会切过来。
- Esc 依次关闭详情和对话框。

链接参数可以直接打开某个状态，方便截图：

```
prototype.html#view=status
prototype.html#open=mill
prototype.html#open=hatchery&chat
```

`open` 取建筑 id（见 `src/world.js` 的 `PLACEMENTS`），`theme` 也可以换成 `day` `blueprint` `night`。

## 方案对比页（index.html）

1. **布局方案**（4 种）：A 全景小镇、B 地图 + 工作台、C 流水线主视角、D 日报首页。
2. **美术风格**（4 种）：纸艺、白昼、蓝图、夜间实验室。布局和风格可以任意组合，预览区实时切换。
3. **方案对比**：布局和风格各一张对比表。
4. **素材库**：22 个建筑、9 个物件、7 个员工、10 个地形与道具，按当前风格显示。
5. **我的选择**：在预览下方点「选定」，底部栏会记住选择（保存在浏览器本地），点「复制结果」就能粘贴给 Claude。

单独打开某个组合（1280×800，适合截图放进 slides）：

```
index.html#layout=B&theme=paper&solo
```

`layout` 可选 `A` `B` `C` `D`，`theme` 可选 `paper` `day` `blueprint` `night`。

预览里的数据（论文标题、相似度、预算等）都是示意数据，不是真实结果。

## 文件结构

```
design/
  prototype.html    构建产物：可交互原型
  index.html        构建产物：方案对比页
  build.mjs         构建脚本：内联生成两个页面，并导出 assets/
  src/
    theme.js        四种风格的色板（浏览器用 CSS，导出时换算成实色）
    sprites.js      等距绘图工具和全部素材定义
    world.js        世界地图：建筑摆放、地面、物流线、标签
    layouts.js      四种布局，以及原型复用的工作台、流水线、日报组件
    gallery.js      方案对比页
    proto.js        原型页：地图平移缩放、建筑详情、对话抽屉、运行状态
    style.css
    template.html
assets/             导出的 SVG 素材和 manifest.json，说明见 assets/README.md
```

## 修改后重新生成

```bash
node design/build.mjs
```

改了 `src/` 里的任何文件都要重新跑一次，两个 HTML 和 `assets/` 都由脚本生成，不要手改。
