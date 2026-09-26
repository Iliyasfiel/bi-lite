# 技术调研：Excel 模板填充保真度（A）与 DuckDB in Node（B）

调研方式：官方文档 + GitHub issue + **本机实测**（Node v26.7.0、exceljs 4.4.0、xlsx-populate 1.21.0、xlsx-template 1.4.7、@duckdb/node-api 1.5.5-r.5、openpyxl 3.1.5、duckdb 1.5.5）。
凡标注「实测」的结论均有可复现脚本与解压后 XML 比对；其余标注来源 URL。信息缺失处明确写「未找到」。

---

# 技术点 A：Excel「模板填充」保真度

## A0. 结论先行（决策建议）

| 方案 | 全特性模板 | 推荐度 |
|---|---|---|
| **xlsx-populate 1.21.0** | 读入 OK、导出版式完整、图表/图片/批注/扩展全保 | ★★★★★ **主选** |
| **直接打 XML 补丁**（unzip→正则改 `<c>`→zip） | 完整保留，零 API 依赖 | ★★★★☆ 兜底/极端场景 |
| xlsx-template 1.4.7 | 保真高，但要求模板预埋 `${}` 且必须有 sharedStrings.xml | ★★★ 仅当模板由你控制 |
| openpyxl（Python） | 图表/图片/批注能保，**但会删掉现代 Excel 扩展**（数据条/图标集/迷你图/x14 数据验证） | ★★☆ **不建议为它引入 Python 子进程** |
| exceljs 4.4.0 | **含图表/图片/批注的模板直接读入崩溃**；即使能读也会丢 drawings、弄坏数据验证 | ✗ **不可用于模板填充** |

---

## A1. exceljs 4.4.0 读入→写值→保存：保留与丢失清单

### A1.1 致命问题：对真实模板连「读入」都会抛异常（实测）

构造一份典型报送模板`template.xlsx`（合并单元格 5 处、单元格样式、数字格式、条件格式 4 条、数据验证 2 条、公式、图表 1、图片 1、批注、冻结窗格、打印区、定义名称），用 exceljs 4.4.0 执行 `new ExcelJS.Workbook().xlsx.readFile(...)`：

```
CRASH  template.xlsx :: Cannot read properties of undefined (reading 'anchors')
       at node_modules/exceljs/lib/xlsx/xlsx.js:100:18
CRASH  t_comment.xlsx :: Cannot read properties of undefined (reading 'comments')
       at node_modules/exceljs/lib/xlsx/xform/sheet/worksheet-xform.js:453:55
CRASH  t_chart.xlsx   :: Cannot read properties of undefined (reading 'anchors')
       at node_modules/exceljs/lib/xlsx/xlsx.js:100:18
OK     t_safe.xlsx    （无图表/图片/批注时才成功）
```

**隔离结论：只要模板里有 1 个批注，或 1 个图表/图片，exceljs 4.4.0 读入即崩。** 仅含合并单元格/样式/数字格式/条件格式/数据验证的模板可以读。

源码级机制（`exceljs@4.4.0`）：

```js
// lib/xlsx/xlsx.js:94-100 —— drawing 为 undefined 时 `|| []` 护不住
Object.keys(model.drawings).forEach(name => {
  const drawing = model.drawings[name];
  ...
  (drawing.anchors || []).forEach(anchor => {   // ← TypeError 在此
// lib/xlsx/xform/sheet/worksheet-xform.js:450-453
if (rel.Type === RelType.Comments) {
  model.comments = options.comments[rel.Target].comments;   // ← options.comments[Target] 为 undefined
}
```

根因：exceljs 用**硬编码正则**识别自己写出的部件名，跨工具写的文件对不上：

```js
// lib/xlsx/xlsx.js:381
/xl\/drawings\/([a-zA-Z0-9]+)[.]xml/
// lib/xlsx/xlsx.js:386
entryName.match(/xl\/(comments\d+)[.]xml/)
```

而 openpyxl/Excel 写的是 `xl/comments/comment1.xml` + `xl/drawings/commentsDrawing1.vml`（sheet1.xml.rels 里 `Target="/xl/comments/comment1.xml" Id="comments"`），正则匹配不到 → options key 为 undefined → 崩。**exceljs 自产文件自读正常，跨工具模板必崩。**

对应 open issue：**[#2949 [open] 2025-07-16 "Reading files with drawings/images"](https://github.com/exceljs/exceljs/issues/2949)** —— 报告者用的正是 4.4.0，贴出的堆栈与我实测一致（`worksheet-xform.js:494/500`、`xlsx.js:95/98`）。

### A1.2 即使能读入，也会丢失/破坏这些

| 项目 | exceljs 4.4.0 表现 | 证据 |
|---|---|---|
| 合并单元格 | ✅ 保留 | 实测 |
| 单元格样式（字体/填充/边框） | ✅ 大体保留 | 实测；[mfyz 实测](https://mfyz.com/nodejs-excel-library-comparison/) 记 "Styles ⚠️ ~Preserved" |
| 数字格式 | ✅ 保留（`#,##0.00` 实测保住） | 实测 |
| 条件格式（基础 `<conditionalFormatting>`） | ⚠️ 保留但**重写**：属性顺序变化、为空的 dxf 字体被去掉 | 实测 |
| 条件格式（x14 扩展：数据条/图标集/迷你图） | ⚠️ **降级**：gradient/border 属性丢失；x14 iconSet 扩展整个丢掉；sparklineGroup 丢掉 | 实测，详见 A1.3 |
| 数据验证 | ❌ **损坏**：范围被展开成逐格后按字典序排序，产生重叠重复规则 | 实测复现 + [mfyz](https://mfyz.com/nodejs-excel-library-comparison/) |
| **图表（charts）** | ❌ **丢失** | 源码 `lib/xlsx/xform/drawing/drawing-xform.js` 只实现 `xdr:twoCellAnchor`/`oneCellAnchor`，**完全没有 chart 的 xform**；[#2607 [open] "Accept and preserve files with charts"](https://github.com/exceljs/exceljs/issues/2607) |
| **图片（images）** | ❌ 丢失 | [#2949](https://github.com/exceljs/exceljs/issues/2949) |
| 批注（comments） | ❌ 读入即崩 | 实测 |
| 工作簿保护 | ❌ 丢失 | [#2854 [open] 2024-12-03](https://github.com/exceljs/exceljs/issues/2854) |
| 定义名称 | ❌ 有丢失报告 | [#1835](https://github.com/exceljs/exceljs/issues/1835) / [#1174](https://github.com/exceljs/exceljs/issues/1174) |
| 模板数据验证 | ❌ 丢失 | [#1184 [open] 2020-03-28](https://github.com/exceljs/exceljs/issues/1184) |
| 条件格式带字体样式 | ⚠️ 曾破坏整个样式表，2021 年由 PR #1574 修复 | [#1583 [closed] 2021-01-07](https://github.com/exceljs/exceljs/issues/1583) |

**数据验证损坏的实测复现**（独立于第三方博客）：

```
输入：<dataValidations count="2">
        <dataValidation sqref="C2:C1013">  <formula1>"a,b"</formula1>
        <dataValidation sqref="D2:D10">    <formula1>=另一张!$A$2:$A$10</formula1>
输出：<dataValidations count="4">
        <dataValidation sqref="C10:C1013">   ← 重叠！
        <dataValidation sqref="C2:C1013">
        <dataValidation sqref="D10">
        <dataValidation sqref="D2:D10">
```
（`formula1` 中引号还被转义成 `&quot;`。此即 mfyz 博客描述的字典序排序 bug。）

### A1.3 现代 Excel 扩展（x14）的实测结论

Excel 2010+ 把数据条/图标集/迷你图/部分数据验证写成 `<extLst><ext uri="{78C0D931-...}"><x14:conditionalFormattings>` 这种扩展块。我构造了同时含 3 种扩展（条件格式扩展、数据验证扩展、迷你图扩展）的模板：

```
t_ext                  extLst=YES CFext=YES DVext=YES Spark=YES x14:dataBar=YES x14:iconSet=YES sparkline=YES
out_ext_xp             extLst=YES CFext=YES DVext=YES Spark=YES x14:dataBar=YES x14:iconSet=YES sparkline=YES   ← 全保
out_ext_exceljs        extLst=YES CFext=YES DVext=NO  Spark=NO  x14:dataBar=YES x14:iconSet=NO  sparkline=NO    ← 半丢
out_ext_openpyxl       extLst=NO  CFext=NO  DVext=NO  Spark=NO  x14:dataBar=NO  x14:iconSet=NO  sparkline=NO    ← 全丢
```

exceljs 会把 x14 扩展「降级重写」成基础 `<conditionalFormatting><cfRule type="dataBar">`，`gradient="1"`/`border="1"` 等保真属性丢失（实测 `gradient=NO border=NO`），iconSet 扩展与 sparkline 扩展直接消失。**对报送模板而言这等于条件格式视觉被改变。**

### A1.4 exceljs 项目维护状况

- npm 最新版 **4.4.0**（`time.modified` 2024-12-20，实际 4.4.0 发布于 2023-10-19）；存在 tag v4.4.1 但无 release。
- 仓库 `exceljs/exceljs`：**open issues 809**、stars 15486、`archived=false`、最后 push 2025-01-21。
- README «Known Issues» 只提 Puppeteer/libfontconfig 与 "Splice vs Merge"，**没有保真度清单** —— 官方从未承认上述问题（我把 README 原文段落读完了）。

---

## A2. 专门做模板填充的 Node 库/方案

### A2.1 xlsx-populate 1.21.0 —— **推荐主选**（实测全保）

```js
const XLSXPopulate = require('xlsx-populate');
const workbook = await XLSXPopulate.fromFileAsync('template.xlsx');
workbook.sheet('报表').cell('D4').value(1234.56);
// 模板填充更稳的写法：用定义名称定位，不依赖坐标
workbook.definedName('数据起始行').value(5);
await workbook.toFileAsync('out.xlsx');
```

实证（对同一份全特性模板 `template.xlsx`，17 部件）：

- 读入 **不崩溃**；写出后 17→18 部件（新增 sharedStrings.xml），9 个共享部件字节变化。
- openpyxl 复核语义：**合并 5、条件格式 4 条、数据验证 2、冻结 A4、打印区 A1:H8、定义名称、图表 1、图片 1、批注保留、A1 字号 16 粗体、F4/D8 公式、D4 数字格式 `#,##0.00` —— 全部保留**。
- `xl/charts/chart1.xml`、`xl/drawings/drawing1.xml`、`xl/media/image1.png`、`xl/comments/comment1.xml`、`xl/drawings/commentsDrawing1.vml` 部件全部在位。
- **`<extLst>` 与源文件逐字节相同**（实测 `extLst byte-identical: True 1185 1185`）——这是它相对 exceljs 的决定性优势。

定位与局限：
- README 自述："keeping existing workbook features and styles in tact"、"Since xlsx-populate just manipulates the XML data, it is able to preserve styles and other content while still only supporting a fraction of the [API]"。官方原文（README）：*"xlsx-populate will **not** recalculate the values as you manipulate the workbook and will **not** write the values to the output."* → **公式缓存值不会重算，也不会写回**（实测：源模板 `<c r="F4" s="4"><f>IF(...)</f><v /></c>`，xlsx-populate 写出后变成 `<c r="F4" s="4"><f>IF(...)</f></c>`，空 `<v/>` 被移除）。这意味着报表里只有 Excel 打开时才显示公式结果——**若下游要直接读数值，需另做处理，或让公式列不参与取值**。
- 支持 defined names 取值填充（README：「Defined names are particularly useful if you are populating data into a known template. Then you do not need to know the exact location.」）：`workbook.definedName("some name").value(5)` / `workbook.sheet(0).definedName("some other name").value("foo")`。
- 其他能力：样式、富文本、数据验证、加密、查找替换。
- 维护状态：npm 最新 **1.21.0（2020-03-01 发布，time.modified 2025-09-09）**；仓库 [dtjohnson/xlsx-populate](https://github.com/dtjohnson/xlsx-populate) stars 1001、open issues 156、**最后 push 2024-03-12、未 archived**。**功能冻结但可用**；社区 fork `@eyeseetea/xlsx-populate` 4.3.1（2025-05-15）可作备选。
- 依赖 `cfb`/`jszip` 等，纯 JS，无原生编译。

### A2.2 xlsx-template 1.4.7 —— 保真高，但要求模板预埋占位符（实测）

```js
const XlsxTemplate = require('xlsx-template');
const t = new XlsxTemplate(fs.readFileSync('template.xlsx'));   // 支持 buffer
t.substitute(1, { unit: '某局', name: '月报' });                  // 或 t.substitute('报表', {...})
const buf = t.generate({ type: 'nodebuffer' });
```

- 占位符语法：`${scalar}`、`${arr[0]}`、列数组（占位符独占单元格时横向展开）、`${table:arrayName.prop}` 表格行展开、`${image:key}`。机制是 "Direct XML DOM manipulation"。
- 实测：对含 chart/image/comment 的 xlsx 做 substitute+generate，18→18 部件、0 missing 0 extra，仅 5 部件字节变化，语义全保（合并 5、条件格式 4、数据验证 2、图表 1、图片 1、批注、冻结、打印区、定义名称、数字格式）。**保真度与 xlsx-populate 同级。**
- **关键局限（实测崩溃）**：对**没有 `sharedStrings.xml` 部件**的模板（例如 openpyxl 写出的纯 inlineStr 文件）直接构造会抛

  ```
  TypeError: Cannot read properties of null (reading 'attrib')
      at node_modules/xlsx-template/lib/index.js:273
  ```
  因为源码假定 `workbookRels.find("Relationship[@Type='...sharedStrings...']")` 必然存在。
- 另一局限：**占位符必须事先写进模板**。对已经做好的报送模板（没有 `${}`）无法使用——你们的场景正是「人工做好的模板，事后往数据区写数值」，因此 xlsx-template **不匹配主流程**，仅适合「模板由系统生成」的子场景。
- 维护：[optilude/xlsx-template](https://github.com/optilude/xlsx-template) stars 455、**最后 push 2026-03-09（仍在维护）**、npm 1.4.7（time.modified 2026-01-17）。

### A2.3 docxtemplater 的 xlsx 模块 —— 商业授权

- 模块名 `docxtemplater-xlsx-module`，Node + PizZip，占位符风格（`{name}`、loop、innerLoop、`preferTemplateFormat`、`fmts`、图片模块）。
- 许可：**付费**。[官方定价](https://docxtemplater.com/pricing/)：单模块 **500 €/年**、PRO 1250 €/年、ENTERPRISE 3000 €/年、PREMIUM 9000 €/年；Xlsx Module 仅在付费档可用（Free 档 MIT/GPLv3 双许可**不含**该模块）。
- 定位：如果预算允许且需要「正式模板引擎」，它是最成熟的商业方案；但**我们的模板是既有的、没有占位符**，同样需要改造模板。

### A2.4 SheetJS（xlsx）—— 社区版不可用于模板填充

- 社区版**不支持样式**（"[Styling is only available in Pro Version of SheetJS](https://stackoverflow.com/questions/50147526/sheetjs-xlsx-cell-styling)"）。
- mfyz 实测（[来源](https://mfyz.com/nodejs-excel-library-comparison/)）：v0.18.5 社区版对含 7 条数据验证、跨表引用、drawings 的工作簿做 round-trip → **数据验证 7→0 全丢、跨表引用丢、drawings 丢、styles.xml 10KB→1KB（样式基本被剥离）、文件 +375KB**。
- Pro 版为商业授权（价格未检索，**未找到**公开报价页）。结论：SheetJS 只适合「读数据 / 转 CSV-JSON」，不适合 round-trip。

---

## A3. 直接修改 xlsx 内部 XML 的轻量方案 —— **可行，且保真度最高**（实测）

xlsx = zip + XML。做法：解压 → 只替换目标 `<c>` 的 `<v>` → 重新打包。

```bash
unzip -qo template.xlsx -d work
# 正则定位 <row ... r="N"> ... 再定位 <c r="D4" ...>，替换为：
#   <c r="D4" s="3"><v>1234.56</v></c>     ← 保留 s= 样式索引，去掉 t= 属性
zip -q -X -r out.xlsx '[Content_Types].xml' _rels docProps xl
```

实测（对全特性 `template.xlsx`，输出 `out_xmlfill.xlsx`，delta -34 bytes）：用 openpyxl 复核 → D4 值 = 1234.56 且数字格式 `#,##0.00` 保留；**合并 5、条件格式 4 条规则、数据验证 2、冻结 A4、打印区、定义名称、图表 1、图片 1、F4/D8 公式 —— 全部原样保留**。Excel 与 openpyxl 均可正常打开。

**这条路是「零 API 依赖、零重写」，保真度是三个方案里最高的**（因为它根本不碰其它部件）。

坑（实测踩到/需留意）：

1. **字符串值不能直接塞 `<v>`**。如果是文本，必须写 `t="s"` + 追加到 `sharedStrings.xml`（并更新 `count`/`uniqueCount`），或者干脆写 `t="inlineStr"><is><t>...</t></is>`。数值才能用裸 `<v>`。
2. **样式索引 `s=` 必须原样保留**，否则数字格式/样式丢失；若无该单元格需要「插入」新 `<c>`，必须自己决定 `s=` 索引（不能猜，要查 `styles.xml` 或复制同行相邻单元格的 `s`）。
3. **公式单元格有缓存值 `<v/>`**：只改公式引用到的数据格时，公式的 `<v>` 会变成过期值。若不希望下游读到旧值，需清空该 `<v>`（或让消费方重新计算）。
4. **zip 重打包必须包含 `[Content_Types].xml`**（它在 zip 根，漏掉文件直接损坏），建议用 `zip -X -r` 且保持 `_rels`/`docProps`/`xl` 目录结构。
5. 合并单元格区域（`<mergeCells>`）本身不需要改，往合并区左上角写值即可。

> 若团队希望少写代码，**xlsx-populate 本质就是这条路的产品化**（README 原文："just manipulates the XML data"，且实测 extLst 逐字节保留）。因此建议：**优先用 xlsx-populate**，把它当作「XML 补丁」的成熟实现；只有在需要处理 xlsx-populate 不支持的边角（例如极大规模的批量写、或需要写入 xlsx-populate API 未覆盖的部件）时才自己打补丁。

---

## A4. openpyxl 是否比 exceljs 更可靠？值不值得引入 Python 子进程？

**比 exceljs 可靠得多，但没有 xlsx-populate 可靠——不值得为它引入 Python 子进程。** 理由如下（全部实测）。

### A4.1 openpyxl 优于 exceljs 的地方

对同一份全特性模板 round-trip：**17→17 部件、0 missing 0 extra**，仅 4 个部件字节变化（`docProps/core.xml`、`drawings/drawing1.xml`、`styles.xml` 5368→7490、`sheet1.xml` 4976→4986）；**`chart1.xml` 与 `media/image1.png` 字节完全相同（sha 一致）**。语义全保：合并 5、条件格式 4、数据验证 2、冻结 A4、打印区、定义名称、图表 1、图片 1、批注、公式、D4 值已改。

跨来源验证（foreign provenance）：把 xlsx-populate 产出的文件用 openpyxl 重载再改值再存 → 图表/图片/批注/合并/条件格式/数据验证全部保留（部件 18→17，丢 sharedStrings 因 openpyxl 改用 inlineStr）。**openpyxl 对非自产文件的保真同样可靠。**

### A4.2 但 openpyxl 有 exceljs 没有的「静默删扩展」问题（实测，**决策关键**）

对含现代 Excel 扩展的模板，openpyxl 会**打印警告并删除**：

```
UserWarning: Conditional Formatting extension is not supported and will be removed
UserWarning: Data Validation extension is not supported and will be removed
UserWarning: Sparkline Group extension is not supported and will be removed
```

实测结果：`out_ext_openpyxl extLst=NO CFext=NO DVext=NO Spark=NO x14:dataBar=NO x14:iconSet=NO sparkline=NO`

源码位置（openpyxl 3.1.5）：

```python
# openpyxl/worksheet/_reader.py:325-330
def parse_extensions(self, element):
    extLst = ExtensionList.from_tree(element)
    for e in extLst.ext:
        ext_type = EXT_TYPES.get(e.uri.upper(), "Unknown")
        msg = "{0} extension is not supported and will be removed".format(ext_type)
        warn(msg)
# openpyxl/xml/constants.py:114  EXT_TYPES 表
#   '{78C0D931-6437-407D-A8EE-F0AAD7539E65}': 'Conditional Formatting',
#   '{CCE6A557-97BC-4B89-ADB6-D9C93CAAB3DF}': 'Data Validation',
#   '{05C60535-1F16-4FD2-B633-F4F36F0B64E0}': 'Sparkline Group',
#   '{A8765BA9-456A-4DAB-B4F3-ACF838C121DE}': 'Slicer List', ...
```

**更严重的是它连基础条件格式都会丢**：Excel 真实的「双表示」输出（基础降级版 + x14 完整版）里，基础 `<cfRule>` 带 `id` 属性时 openpyxl 会整条丢弃：

```
OPENPYXL WARN: Failed to load a conditional formatting rule. It will be discarded.
               Cause: Rule.__init__() got an unexpected keyword argument 'id'
实测：out_dual_openpyxl  baseDataBar=NO baseIconSet=YES（数据条规则整条消失）
```

官方文档也自认（[openpyxl tutorial](https://openpyxl.readthedocs.io/en/stable/tutorial.html)）：

> **Warning** openpyxl does currently not read all possible items in an Excel file so shapes will be lost from existing files if they are opened and saved with the same name.

以及 `load_workbook` 标志说明：`read-only` 模式 "not all features are available (**charts, images, etc.**)"、`rich_text` 默认 False（富文本不保）、`keep_vba` 默认 False（宏不保）。

### A4.3 结论

- openpyxl 的**保真度 ≤ xlsx-populate**（后者 extLst 逐字节保留，前者直接删掉）。
- 引入 Python 子进程会带来：额外运行时依赖、跨进程 IPC/临时文件、部署复杂度、错误处理边界。**为了一个更差的结果付这个代价，不划算。**
- **建议：Node 侧统一用 xlsx-populate（或自打 XML 补丁），不引入 Python。**
- 唯一可以考虑 openpyxl 的场景：你们团队已大量使用 Python 做数据处理，且**模板不含数据条/图标集/迷你图/x14 数据验证**——这时 openpyxl 是可靠的。但只要模板不确定，就不要赌。

---

## A5. 已知的「保真度」实测对比结论

### A5.1 第三方实测（可直接引用）

[**I Tested Three Node.js Excel Libraries So You Don't Have To** — mfyz, 2026-03-24](https://mfyz.com/nodejs-excel-library-comparison/)
方法：6 sheet、7 条跨表 dropdown 数据验证、drawings/charts、各类样式；解压比对 XML。

| 能力 | ExcelJS 4.4.0 | SheetJS 0.18.5（社区） | xlsx-populate 1.21.0 |
|---|---|---|---|
| 数据验证 | ❌ 7→14 条（重复/重叠） | ❌ 7→0 全丢 | ✅ 7→7 精确保留 |
| 跨表 dropdown 引用 | ❌ 范围被改坏 | ❌ 丢失 | ✅ 完好 |
| Drawings / Charts | ❌ 丢失 | ❌ 丢失 | ✅ 保留 |
| 样式 | ⚠️ 大体保留 | ❌ styles.xml 10KB→1KB | ✅ 保留 |
| 文件大小影响 | +2KB | +375KB | −5KB |
| 周下载量 | ~500k | ~2M | ~50k |

作者结论原文：*"skip ExcelJS for workbooks that already have data validations"*；*"Use xlsx-populate when you need to preserve data validations with cross-sheet references, or when workbooks have dropdowns, conditional formatting, or other advanced features. Basically any read/modify/write workflow on existing workbooks."* 该文还给出了机制解释：*"Libraries that parse this XML into an internal model and regenerate it on write (like ExcelJS) introduce transformation risk. Libraries that preserve the original XML structure (like xlsx-populate) don't have that problem."*

另有 [jstool 的对比博客](https://jstool.gitlab.io/blog/posts/javascript-excel-xlsx-libraries-comparison/) 称 xlsx-populate "Perfect for preserving complex Excel templates (charts, logos, print areas)"。

### A5.2 我自己的实测对照表（同一份全特性 `template.xlsx`，openpyxl 复核语义）

| 项 | template | exceljs 4.4.0 | xlsx-populate | openpyxl | 自打 XML 补丁 |
|---|---|---|---|---|---|
| **读入** | — | **崩溃**（anchors/comments） | OK | OK | OK |
| 合并 / 条件格式 / 数据验证 / 冻结 / 打印区 / 定义名称 | 5/4/2/A4/A1:H8/1 | 能读时全保 | 全保 | 全保 | 全保 |
| 图表 / 图片 / 批注 | 1/1/有 | **全丢** | 1/1/有 | 1/1/有 | 1/1/有 |
| 现代 Excel 扩展（x14 数据条/图标集/迷你图） | 有 | **部分丢**（gradient/border 丢、iconSet/sparkline 丢） | **逐字节保留** | **全删** | 保留 |
| 数据验证范围 | 原样 | **拆成重叠重复** | 原样 | 原样 | 原样 |
| 公式缓存值 | 有 | 保留 | **不写回**（清空 `<v/>`） | 保留 | 保留（除非手动清） |
| 部件数 | 17 | 读不了 | 18 | 17 | 17 |

---

# 技术点 B：DuckDB 在 Node 中的使用

## B1. `@duckdb/node-api` 1.5.x 现状

### B1.1 API 风格：全 Promise 化，无 Sync 变体（实测）

实测脚本 `/tmp/bire/xltest/b1.mjs`（`@duckdb/node-api` 1.5.5-r.5，本机 `version() === 'v1.5.5'`）：

```js
import { DuckDBInstance, DuckDBInstanceCache } from '@duckdb/node-api';

const instance = await DuckDBInstance.create('/path/db.duckdb');       // 或 ':memory:'
const instance2 = await DuckDBInstance.fromCache('/path/db.duckdb');   // 同进程共享实例
const cache = new DuckDBInstanceCache();
const i3 = await cache.getOrCreateInstance('/path/db.duckdb');

const conn = await instance.connect();
await conn.run('CREATE TABLE t AS SELECT 42 AS a');                    // 不取数
const reader = await conn.runAndReadAll('SELECT * FROM t');            // 取数（推荐）
reader.getRows(); reader.getRowObjects(); reader.getColumns();
reader.getColumnsObject(); reader.columnNames(); reader.columnTypes();
reader.getRowsJson(); reader.getRowObjectsJson();                      // bigint/date 转字符串
```

- 仅有少数同步方法：`closeSync()` / `disconnectSync()` / `flushSync()`。其余全为 Promise。
- 结果读取类层次（实测）：`conn.run()` 返回 **`DuckDBMaterializedResult`，只有 `getChunk(i)`，没有 `getRows()`** → 取数**必须**走 `runAndRead()` / `runAndReadAll()` / `streamAndRead*()`。
- 连接方法全集（实测枚举）：`run` / `runAndRead` / `runAndReadAll` / `runUntilLast` / `stream` / `streamAndRead(All/Until)` / `start(ThenRead…)` / `prepare` / `createPrepared` / `extractStatements` / `createAppender` / `getTableNames` / `registerTableFunction` / `registerScalarFunction` / `interrupt` / `closeSync` / `disconnectSync`。
- ⚠️ **踩坑**：`JSON.stringify(reader.getRows())` 会抛 `TypeError: Do not know how to serialize a BigInt`。要序列化就用 `getRowsJson()` / `getRowObjectsJson()`。
- 参数绑定：`await conn.run('select $a, $b', { a: 'duck', b: 42 })`，或 `conn.prepare()` + `prepared.bindVarchar/bindInteger/bindList/bind({...},{...})`。
- 文档：[Node.js Client (Neo)](https://duckdb.org/docs/current/clients/node_neo/overview)（raw: `https://raw.githubusercontent.com/duckdb/duckdb-web/main/docs/current/clients/node_neo/overview.md`）。
- 官方原文：*"Multiple instances in the same process should not attach the same database."* → 用 `DuckDBInstance.fromCache()` 或 `DuckDBInstanceCache` 规避。
- Roadmap 未完成项（官方文档明列）：MAP/UNION 类型绑定与追加、逐行追加默认值、UDF/UDT、Profiling info、Table description、Arrow API。→ **如果你们需要注册自定义 UDF，node_neo 目前不支持**（这是选型风险点，需评估）。
- 平台：`linux_amd64`、`linux_arm64`、`osx_amd64`、`osx_arm64`、`windows_amd64`。**`windows_arm64` 不支持**。

### B1.2 Parquet 直读：支持（实测）

```js
await conn.runAndReadAll("SELECT count(*) c FROM read_parquet('/tmp/bire/b1ro.parquet')");  // → 1
await conn.runAndReadAll("SELECT count(*) c FROM '/tmp/bire/pq/**/*.parquet'");             // → 2000（glob 直查）
```
Parquet 读写在核心引擎内，非扩展，开箱即用。

### B1.3 READ_ONLY 模式与多进程（实测）

```js
const inst = await DuckDBInstance.create('/path/db.duckdb', { access_mode: 'READ_ONLY' });
const c = await inst.connect();
await c.runAndReadAll("SELECT current_setting('access_mode') m");   // → [{ m: 'read_only' }]
```
`access_mode` 是合法配置项（`configurationOptionDescriptions()` 共 299 项，注释："Access mode of the database (AUTOMATIC, READ_ONLY or READ_WRITE)"）。多进程详见 B2。

### B1.4 旧包 `duckdb` 已废弃 + **供应链安全事件**

- 旧包 [`duckdb`](https://www.npmjs.com/package/duckdb) 与 [文档页](https://duckdb.org/docs/lts/clients/nodejs/overview) 均标注 **Deprecated**，指向 `@duckdb/node-api`。
- npm 版本对照（实测）：`@duckdb/node-api` **latest = 1.5.5-r.5**，`lts-v1.4 = 1.4.5-r.1`。
- 仓库 [duckdb/duckdb-node-neo](https://github.com/duckdb/duckdb-node-neo)：stars 199、open issues 28、最后 push 2026-09-26、未 archived、MIT。
- ⚠️ **安全事件（必须知道）**：[GHSA-w62p-hx95-gf2c / CVE-2025-59037](https://github.com/duckdb/duckdb-node/security/advisories/GHSA-w62p-hx95-gf2c)，severity **high**，2025-09-09。攻击者通过钓鱼拿到 npm 维护者账号，发布含**干扰加密货币交易恶意代码**的版本：`@duckdb/node-api@1.3.3`、`@duckdb/node-bindings@1.3.3`、`duckdb@1.3.3`、`@duckdb/duckdb-wasm@1.29.2`。官方已 deprecate 并请 npm 删除这些版本，同时发布了更高版本号（1.3.4/1.30.0）作为保护。**部署时应锁定版本 + 校验 lockfile，不要用 `^` 浮动范围**（本机实测 `npm view duckdb` 已找不到 1.3.3，说明已从 registry 删除）。

---

## B2. DuckDB single-writer 限制的确切含义

### B2.1 官方定义

[Concurrency – DuckDB](https://duckdb.org/docs/current/connect/concurrency) 原文：

> 1. **Read-write mode:** one process can both read and write to the database.
> 2. **Read-only mode:** multiple processes can read from the database, but no processes can write (`access_mode = 'READ_ONLY'`).
>
> When using read-write mode, DuckDB supports multiple writer threads using a combination of MVCC and optimistic concurrency control (see Concurrency within a Single Process), **but all within that single writer process**. The reason for this concurrency model is to allow for the caching of data in RAM for faster analytical queries...

**Multiple Processes 段（新版文档新增，重要）**：

> Writing to DuckDB's native database format from multiple processes is supported through the **Quack remote protocol**, which turns DuckDB into a client-server database. Quack in beta stage as of DuckDB v1.5.2, and is expected to become mature by **DuckDB v2.0 in fall 2026**.
> For a stable solution, consider using the **DuckLake** format with **PostgreSQL as the catalog database**... The DuckLake v1.0 specification and its DuckDB implementation... were published in April 2026.

**Troubleshooting 原文**：*"**File locks.** DuckDB handles concurrent database access requests using file locks. Exercise extra caution when accessing a DuckDB database file in a shared directory (e.g., from different operating systems using different file systems or on network attached storage)."*

### B2.2 实测矩阵（这台机器上跑出来的）

| 场景 | 结果 |
|---|---|
| 同进程、同一 instance、多连接：读 | ✅ OK |
| 同进程、同一 instance、多连接：写（`c2.run("INSERT ...")`） | ✅ OK |
| 同进程、另建 `DuckDBInstance.create(同一文件)` (rw) | ✅ OK |
| 同进程、再建 `access_mode:'READ_ONLY'` instance | ✅ OK |
| **跨进程：第二个进程（rw）** | ❌ 拒绝 |
| **跨进程：第二个进程（`access_mode:'READ_ONLY'`）** | ❌ **同样拒绝** |
| 无写者时：3 个并发 READ_ONLY 进程 | ✅ 全部 OK |
| 无写者时：之后另开 rw writer | ✅ OK |

跨进程拒绝时的确切报错（实测，已 CHECKPOINT 过、`.wal` 不存在也一样）：

```
IO Error: Could not set lock on file "/private/tmp/bire/b2d.duckdb":
Conflicting lock is held in /opt/homebrew/Cellar/node/26.7.0/bin/node (PID 18935)
by user zhaofuqing. See also https://duckdb.org/docs/stable/connect/concurrency
```

另一个文案（rw 情形，提示可以用 readonly，但**实际 readonly 也拿不到锁**）：

```
IO Error: Could not set lock on file "...".
However, you would be able to open this database in read-only mode,
e.g. by using the -readonly parameter in the CLI.
```

**核心结论：官方那句「multiple processes can read」只在「没有任何写者」时成立。只要有一个进程以 read-write 打开，其它进程——无论 rw 还是 READ_ONLY——全部拿不到文件锁。** 这一点我在干净的跨进程 ATTACH 测试里再次确认：

```
--- reader while holder alive:
FAIL: ATTACH '/tmp/bire/cx/staging.duckdb' AS staging (READ_ONLY)
      -> IO Error: Could not set lock on file "...": Conflicting lock is held ...
--- reader after holder exits:
OK  : ATTACH '...' AS staging (READ_ONLY) -> []
OK  : SELECT count(*) n FROM staging.b   -> [{"n":"3"}]
```

参考第三方整理：[Can I open duckdb file in read only mode while other process writing? (StackOverflow)](https://stackoverflow.com/questions/77364053/can-i-open-duckdb-file-in-read-only-mode-while-other-process-writing-to-the-the) —— *"So, you can have multiple read-only processes read the database, but one and only one connection when it is writable."*

### B2.3 官方推荐的「导入与查询并发」做法（关键问题的答案）

**文档层面没有一个叫「导入不阻塞查询」的专门章节**（我通读了 concurrency 文档全文，**未找到**这样的章节）。但把官方给的线索拼起来，结论明确：

1. **同进程内**：DuckDB 的 MVCC 让「读」不被「写」阻塞（读者看到事务前快照）。所以**最简做法是把导入和查询放在同一个进程里** —— 用同一个 `DuckDBInstance`，导入用一条大批量语句（`INSERT INTO ... SELECT * FROM read_parquet(...)` 或 `COPY`），查询用另外的连接。Appends 永不冲突（官方原文：*"Appends will never conflict, even on the same table."*）。
   - 注意：同一 instance 的并发查询**共享同一个 `memory_limit` 预算**（参见 [How to Stop DuckDB Queries Exhausting Memory](https://oneuptime.com/blog/post/2026-09-08-prevent-duckdb-memory-exhaustion-parquet/view)），需要用信号量/队列限制并发查询数。
2. **必须跨进程时**（例如导入由独立 worker 做）：**不要共享 DuckDB 原生库文件**。两条可行路线（均已实测）：
   - **A. staging 文件 + ATTACH**：写者进程独占 `staging/import1.duckdb`；主进程在写者 checkpoint 后 `ATTACH '.../import1.duckdb' AS staging (READ_ONLY)` 再聚合。**实测在写者存活期间 ATTACH 会失败**（锁），因此必须让写者**写完就关闭/释放**，或走路线 B。
   - **B.（推荐）每批一个 Parquet 文件**：写者只写 Parquet（不碰 DuckDB 库文件），主进程直接 `FROM '/data/batches/*.parquet'`。**实测零锁冲突、多进程完全无碍**。
3. **社区/第三方的工程化建议**（[How to Handle DuckDB's Single-Process Write Lock in Multi-Process Systems](https://oneuptime.com/blog/post/2026-09-08-handle-duckdb-single-process-write-lock/view)）：
   - 单一 writer owner 进程，其它 worker 通过 IPC/队列提交 typed 命令；
   - 幂等键协议，例如 `{operation:'append_events_v1', idempotency_key:'batch-...', rows_uri:'/srv/staging/batch-XXXX.parquet'}`，事务内先查幂等表再 `INSERT INTO events SELECT * FROM read_parquet(?)`；
   - **独立读者不要读「活文件」**：让 owner checkpoint → 关闭 → 拷贝出一个版本化文件再 READ_ONLY 打开；或者干脆只发布 Parquet + 原子 manifest。
   - 官方文档也支持「版本化快照」这一思路（读者读的是不可变文件）。

> 给 bi-lite 的建议：**导入路径只产出 Parquet（每批一个文件，原子重命名落盘），查询直接 glob 读 Parquet；DuckDB 库文件只作为可选的物化/加速层，且只由单进程持有。** 这样完全绕开单写者锁。

### B2.4 单进程内的并发语义（官方原文，用于正确性设计）

> As long as there are no write conflicts, multiple concurrent writes will succeed. **Appends will never conflict, even on the same table.** Multiple threads can also simultaneously update separate tables or separate subsets of the same table. Optimistic concurrency control comes into play when two threads attempt to edit (update or delete) the same row at the same time. In that situation, the second thread to attempt the edit will fail with a conflict error.
> `Transaction conflict: cannot update a table that has been altered!`
> Tip: A common workaround when a transaction conflict is encountered is to rerun the transaction.

---

## B3. DuckDB + SQLite 组合的架构模式

**这个组合确实有真实项目在用，是「列存分析 + 行存事务/元数据」的经典分工。** 三个可引用的证据：

### B3.1 zenith（Go + DuckDB + SQLite，隐私优先的自托管网站分析）

[MUKE-coder/zenith](https://github.com/MUKE-coder/zenith)（stars 5、最后 push 2026-07-29）。README 原文：

> Everything stateful lives in the `zenith-data` volume — **DuckDB (events) and SQLite (app data)**.
> Two stores, not one: **DuckDB is columnar and answers `GROUP BY` over large event volumes; SQLite is transactional and holds users, sites, and settings. Events never go in SQLite; app data never go in DuckDB.** Both sit behind the `EventStore` / `AppStore` interfaces in `core/internal/storage/storage.go`, so a hosted tier can later swap in ClickHouse and Postgres without business logic changing.

环境变量：`ZENITH_EVENTS_DB=$DATA_DIR/events.duckdb`、`ZENITH_APP_DB=$DATA_DIR/zenith.sqlite`。

**可直接抄的两段并发配置**（源码原文）：

```go
// core/internal/storage/duckdb/duckdb.go:35-36
// DuckDB is single-writer; more connections buy contention, not throughput.
db.SetMaxOpenConns(1)

// core/internal/storage/sqlite/sqlite.go:34-36
// WAL keeps reads from blocking the writer; busy_timeout absorbs the brief
// contention that remains instead of surfacing SQLITE_BUSY to a request.
dsn := path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)"
```

这两行就是 B2 的工程答案：**DuckDB 连接池限 1；SQLite 开 WAL + busy_timeout**。Node 侧等价写法：

```js
// better-sqlite3
const db = new Database('app.sqlite');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');
```

### B3.2 duckling（Tauri 桌面数据浏览器，同时原生支持 DuckDB 与 SQLite）

[l1xnan/duckling](https://github.com/l1xnan/duckling)（stars 580、最后 push 2026-09-23）：*"It supports DuckDB / SQLite natively"*，两种数据源各走各的连接器（用于浏览 parquet/csv/json 与各类数据库）。是「同一应用内并存两种引擎」的成熟样例，但它不是「SQLite 存元数据/DuckDB 存明细」的分工模式。

### B3.3 DuckLake：**官方推荐用 SQLite 做 catalog**（这条最有分量）

[DuckLake — Choosing a Catalog Database](https://ducklake.select/docs/stable/duckdb/usage/choosing_a_catalog_database) 原文：

> - If you would like to perform local data warehousing with a **single client**, use **DuckDB** as the catalog database.
> - If you would like to perform local data warehousing using **multiple local clients**, use **SQLite** as the catalog database.
> - If you would like to operate a multi-user lakehouse with potentially remote clients, use **PostgreSQL** as the catalog database.

```sql
INSTALL ducklake; INSTALL sqlite;
ATTACH 'ducklake:sqlite:metadata.sqlite' AS my_ducklake ( DATA_PATH 'data_files/' );
USE my_ducklake;
```

文档对 SQLite 作为并发 catalog 的评价（对 B2 很有用）：

> While SQLite doesn't allow concurrent reads and writes, its default mode is to ATTACH and DETACH for every query, together with providing a "retry time-out" for queries when a write-lock is encountered. **This allows a reasonable amount of multi-processing support (effectively hiding the single-writer model).**

注意已知问题：[ducklake#128 "concurrent transactions with sqlite catalog block each other"](https://github.com/duckdb/ducklake/issues/128) —— 用 sqlite catalog 做三个并发数 GB 级 insert 会互相阻塞。**这正好说明为什么「每批一个 Parquet」比「共享一个库文件」更适合导入场景。**

### B3.4 DuckDB 的 sqlite 扩展本身（实测，可作为「让 DuckDB 直接读写 SQLite」的桥梁）

```js
await c.run('INSTALL sqlite'); await c.run('LOAD sqlite');
await c.run("ATTACH '/tmp/bire/meta.sqlite' AS meta (TYPE sqlite)");
await c.run('CREATE TABLE meta.datasets(id INTEGER, ds_name VARCHAR)');
await c.run("INSERT INTO meta.datasets VALUES (1, 'sales'), (2, 'costs')");
await c.run('SELECT * FROM meta.datasets');
```

实测：`duckdb_extensions()` 里名称是 **`sqlite_scanner`**（不是 `sqlite`），installed/loaded 均为 true。产出文件 header 为 `SQLite format 3`、8192 bytes；**用 Python 标准库 `sqlite3` 独立打开验证**：表 `datasets` 存在、读出 `[(1,'sales'),(2,'costs')]`。

⚠️ 实测踩坑：`CREATE TABLE meta.datasets AS SELECT 1 id, 'sales' name` 报 `Parser Error: syntax error at or near "name"`（`name` 关键字冲突），且 CREATE-AS 在 sqlite attach 上失败后表未建成。**用显式列定义 + INSERT 即可。** 另外注意 sqlite 文件本身不受 DuckDB 单写者锁约束，可作元数据/事务侧存储。

仓库：[duckdb/duckdb-sqlite](https://github.com/duckdb/duckdb-sqlite)（stars 291、最后 push 2026-09-25），README：*"The SQLite extension allows DuckDB to directly read and write data from a SQLite database file... Data can be loaded from SQLite tables into DuckDB tables, or vice versa."*

---

## B4. DuckDB 的 Excel / CSV 读取扩展现状

### B4.1 `excel` 扩展已可用，且是 core 扩展、自动加载（实测）

本机 `duckdb_extensions()` 中 excel 条目：

```
description = "Adds support for Excel-like format strings"
installed = true, loaded = true
path = /tmp/bire/duckdb_ext/v1.5.5/osx_arm64/excel.duckdb_extension
type = REPOSITORY, category = core
```

首次 `SELECT * FROM read_xlsx(...)` 会**自动 INSTALL + LOAD**（autoload）。手工方式：

```sql
INSTALL excel;
LOAD excel;
```

实测读 xlsx（本机 duckdb 1.5.5）：

```sql
SELECT * FROM read_xlsx('/tmp/bire/duckexcel.xlsx');
-- → [['北京',100,'2024-01-01'], ['上海',200,'2024-01-02'], ['广州',300,'2024-01-03']]
SELECT * FROM read_xlsx('/tmp/bire/xl/template.xlsx', sheet='报表');   -- 复杂表头模板也能读
```

`duckdb_functions()` 里 `function_name ILIKE '%xlsx%'` **只返回 `read_xlsx`**（table function）。`header=` 与 `sheet=` 生效；`all_varchar=true` 后数字变字符串。

官方文档 [Excel Extension](https://duckdb.org/docs/current/core_extensions/excel) 原文：

> The `excel` extension provides functions to format numbers per Excel's formatting rules by wrapping the [i18npool library] and to read/write Excel (`.xlsx`) files. **However, please note that `.xls` files are not supported.**

`read_xlsx` 参数（官方表格）：

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `header` | BOOLEAN | 自动推断 | 首行是否作为列名 |
| `sheet` | VARCHAR | 自动推断 | 工作表名，默认第一张 |
| `all_varchar` | BOOLEAN | false | 全部按字符串读 |
| `ignore_errors` | BOOLEAN | false | 跳过无法转换的单元格 |
| `range` | VARCHAR | 自动推断 | 读取范围 |
| `stop_at_empty` | BOOLEAN | 有 range 时 false，否则 true | 遇空行停止 |
| `empty_as_varchar` | BOOLEAN | false | 空单元格当作 VARCHAR（默认 DOUBLE） |

类型推断规则（官方）：TIMESTAMP/TIME/DATE/BOOLEAN 依据**单元格格式**推断；文本 `TRUE`/`FALSE` → BOOLEAN；空单元格默认 DOUBLE（除非 `empty_as_varchar`）；**类型按第一个数据行推断**，故首行不具代表性时用 `ignore_errors`/`empty_as_varchar`。

### B4.2 写 xlsx（实测语法，官方表格）

```sql
COPY test TO 'test.xlsx' WITH (FORMAT xlsx, HEADER true);
```
选项：`header`（默认 false）、`sheet`（默认 `Sheet1`）、`sheet_row_limit`（默认 1048576，超出报错）。写出时的转换规则（官方）：数值转 DOUBLE、日期转 Excel 序列号、TIMESTAMP_TZ/TIME_TZ 转 UTC **丢时区**、BOOLEAN→1/0、其余转 VARCHAR。

> ⚠️ **这对你们的技术点 A 不是替代方案**：`COPY ... TO ... (FORMAT xlsx)` 是「从表生成新 xlsx」，**不是「加载既有模板再填值」**，完全无法保留原模板的表头/样式/合并/条件格式。它只适合导出纯数据表。

### B4.3 CSV 为内建能力

CSV 读取是核心引擎内建（`read_csv`、`read_csv_auto`，以及直接 `SELECT * FROM 'test.csv'`），无需扩展。官方 [Importing Data](https://duckdb.org/docs/current/data/overview) 原文：*"Data can be efficiently loaded from CSV files using several methods. The simplest is using the CSV file's name: `SELECT * FROM 'test.csv';`"*。

### B4.4 相关文档路径

- LTS 版文档：[docs/lts/core_extensions/excel](https://duckdb.org/docs/lts/core_extensions/excel)、[docs/lts/guides/file_formats/excel_import](https://duckdb.org/docs/lts/guides/file_formats/excel_import)
- 扩展仓库：[github.com/duckdb/duckdb-excel](https://github.com/duckdb/duckdb-excel)

---

## B5. DuckDB 数据库文件加密能力现状

### B5.1 有原生加密（v1.4.0 起），但**不能通过 Node 客户端配置项开启**（实测）

官方博客 [Encryption in DuckDB（2025-11-19）](https://duckdb.org/2025/11/19/encryption-in-duckdb)：v1.4.0 起支持透明数据加密（data-at-rest），**AES-GCM-256（默认）与 AES-CTR-256**。

**Node 侧踩坑（实测）**：

```js
await DuckDBInstance.create(path, { encryption_key: 'k' });
// → Invalid Input Error: The following options were not recognized: encryption_key
```
`duckdb.configurationOptionDescriptions()` 里**没有** `encryption_key` / `encryption_cipher`（实测 grep 确认）。`SET encryption_key = '...'` 也报 `Catalog Error: unrecognized configuration parameter "encryption_key"`。

**唯一可行路径是 SQL `ATTACH`**（实测成功）：

```sql
ATTACH '/tmp/bire/enc.duckdb' AS enc (ENCRYPTION_KEY 'correct-horse-battery-staple-32b');
ATTACH '/tmp/bire/plain.duckdb' AS plain;
USE plain;
-- 已有数据时：
COPY FROM DATABASE plain TO enc;
```

实测校验：

```sql
SELECT database_name, encrypted, cipher FROM duckdb_databases();
-- → [['enc', true, 'GCM'], ['plain', false, null], ...]
```

- 加密文件头 16 字节仍含可见 `DUCK` 字样（**主 header 保持明文**，与官网一致：不含敏感数据，其余 header 与 block 全部加密）。
- 错误密钥：`Invalid Input Error: Wrong encryption key used to open the database file`
- 不给密钥：`Catalog Error: Cannot open encrypted database "..." without a key`
- 带密钥 READ_ONLY ATTACH：✅ 正常读出数据（实测 `[[1,'top']]`）
- 可选 `ENCRYPTION_CIPHER 'CTR'`（默认 GCM）——见 [ATTACH 参数表](https://duckdb.org/docs/current/sql/statements/attach)：`ENCRYPTION_KEY`（VARCHAR，默认 -）、`ENCRYPTION_CIPHER`（`CBC`/`CTR`/`GCM`）。

### B5.2 加密的限制（官方明说，必须知道）

- **"DuckDB's encryption does not yet meet the official NIST requirements"**，跟踪 issue [duckdb/duckdb#20162 "Store and verify tag for canary encryption"](https://github.com/duckdb/duckdb/issues/20162)。→ **合规场景（等保/密评）不能仅依赖它**，需叠加文件系统级加密（LUKS/FileVault/dm-crypt）或应用层加密。
- 密钥管理**完全由用户负责**；建议 32 字节 base64 密钥；派生密钥存于 secure encryption key cache（锁定内存、不换页）。
- WAL 加密：**只要给了加密 key，WAL 默认就被加密**（对任何加密/未加密库）。若需强制保留 WAL：
  ```sql
  PRAGMA disable_checkpoint_on_shutdown;
  PRAGMA wal_autocheckpoint = '1TB';
  ```
- 临时文件加密：attach 加密库时**自动**加密；或 `SET temp_file_encryption = true`（主库明文时也可只加密临时文件）。该选项在 Node 的配置项表里存在（实测：`temp_file_encryption => "Encrypt all temporary files if database is encrypted"`）。
- 解密 = `COPY FROM DATABASE encrypted TO unencrypted`；重新加密 = 拷到新加密库。
- Parquet 列加密**早已支持**（与库加密独立）：[docs/current/data/parquet/encryption](https://duckdb.org/docs/current/data/parquet/encryption.html)。

### B5.3 结论

有原生加密，但：① Node 侧只能用 SQL ATTACH 开启，不能作为连接配置；② **不满足 NIST**，合规场景必须叠加文件系统加密；③ 密钥管理自负。**建议：文件系统级加密作为基线（部署层解决），DuckDB 原生加密作为额外的「文件被单独拷走」防护。**

---

## B6. Parquet 分区的推荐做法 + 「每批导入一个 Parquet 文件」

### B6.1 Hive 分区 vs 单文件：官方官方口径

[Partitioned Writes](https://duckdb.org/docs/current/data/partitioning/partitioned_writes) 原文：

> **Best practice:** Writing data into many small partitions is expensive. **It is generally recommended to have at least `100 MB` of data per partition.**
> Note that it can be very expensive to write a larger number of partitions as many files will be created. The ideal partition count depends on how large your dataset is.

[File Formats（性能指南）](https://duckdb.org/docs/lts/guides/performance/file_formats)原文：

> DuckDB works best on Parquet files with **row groups of 100K-1M rows each**. The reason for this is that DuckDB can only parallelize over row groups.

所以：**行组 100K–1M 行 / 分区 ≥100MB** 是两条硬性经验值。分区列基数高（比如按天×用户）会把文件数炸掉，要避免。

### B6.2 写 Hive 分区（实测语法 + 官方参数）

```sql
COPY orders TO 'orders' (FORMAT parquet, PARTITION_BY (year, month));
-- 允许覆盖
COPY orders TO 'orders' (FORMAT parquet, PARTITION_BY (year, month), OVERWRITE_OR_IGNORE);
-- 追加（实测推荐用于「每批导入」）
COPY orders TO 'orders' (FORMAT parquet, PARTITION_BY (year, month), APPEND);
-- 自定义文件名
COPY orders TO 'orders'
  (FORMAT parquet, PARTITION_BY (year, month), OVERWRITE_OR_IGNORE, FILENAME_PATTERN 'file_{uuid}');
```

官方注意事项：
- **`PARTITION_BY` 不能使用表达式**，需先在子查询里造列：
  ```sql
  COPY (SELECT *, year(timestamp) AS year, month(timestamp) AS month FROM services)
  TO 'test' (PARTITION_BY (year, month));
  ```
- 「Currently, **one file is written per thread** to each directory.」→ 分区目录里会出现 `data_0.parquet`、`data_1.parquet`…（实测产出 `batch_id=batch0/data_0.parquet` 等）。
- 用 `partitioned_write_max_open_files` 限制同时打开的文件数（默认 100）：`SET partitioned_write_max_open_files = 10;`
- **远程文件系统不支持覆盖**。
- `APPEND` 行为 ≈ `OVERWRITE_OR_IGNORE + FILENAME_PATTERN '{uuid}'`，但会额外检查文件是否已存在并在冲突时重新生成 UUID。
- 列名含 `/` 时用 `url_encode` 做百分号编码。

### B6.3 读 Hive 分区（实测）

```sql
-- glob 直查（含目录通配）
SELECT count(*) FROM '/tmp/bire/pq/hive/**/*.parquet';              -- → 1000
-- 显式 read_parquet + hive_partitioning
FROM read_parquet('/tmp/bire/pq/hive/*/*.parquet', hive_partitioning = true);
-- 实测：GROUP BY batch_id → batch0 334 / batch1 333 / batch2 333
-- filename 虚拟列（v1.3.0 起自动可用，实测返回绝对路径）
SELECT *, filename FROM read_parquet('...*.parquet');
-- 跨 schema 合并（实测 2000 行）
SELECT * FROM read_parquet(['/tmp/bire/a.parquet', '/tmp/bire/pq/**/*.parquet'], union_by_name = true);
```

官方说明（[Hive Partitioning](https://duckdb.org/docs/current/data/partitioning/hive_partitioning)）：读取时分区列从目录结构解析，`hive_partitioning=false` **不**返回分区列，`true` 才返回（默认 auto-detected）。[Parquet overview](https://duckdb.org/docs/current/data/parquet/overview) 参数表：`hive_partitioning`（BOOL，auto-detected）、`union_by_name`（BOOL，false）、`filename`（v1.3.0 起自动作为虚拟列）、`file_row_number`、`schema`、`binary_as_string`、`encryption_config`。

[Reading Multiple Files](https://duckdb.org/docs/current/data/multiple_files/overview) 支持 glob（`*`、`**`）、路径列表、以及 `union_by_name=true` + `filename=true`。

### B6.4 「每批导入一个 Parquet 文件」是否常见？——**常见且推荐**（实测可行）

- **官方层面**：`PER_THREAD_OUTPUT` 的存在说明「多文件」是设计内的一等场景；`PARTITION_BY` + `APPEND` 就是为增量导入设计的；官方明确说 *"Using a glob pattern upon read or a Hive partitioning structure are good ways to transparently handle multiple files."*
- **实测结论**：我让写者进程把批次 `COPY batch1 TO '/tmp/bire/staging/batch1.parquet'`，主库用
  ```sql
  SELECT count(*) FROM '/tmp/bire/staging/*.parquet';
  SELECT count(*) FROM read_parquet('/tmp/bire/staging/*.parquet', union_by_name = true);
  ```
  两种方式都能读，且**多进程下零锁冲突**（写者不碰 DuckDB 库文件）。这是 B2 里「导入不阻塞查询」最干净的答案。
- **第三方佐证**：Dumky de Wilde 的摄取模式总结（[LinkedIn 帖](https://www.linkedin.com/posts/dumkydewilde_turn-thousands-of-messy-json-files-into-one-activity-7378116988667064320-LVYw)）—— daily partitioning by `ingestion_date`、按常用过滤列 clustering、先把脏 JSON 过一次转成干净 Parquet。另一个视角：*"S3 or similar storage is not made for many files, it's made for large files."*

### B6.5 小文件问题（必须提前设计）

- 官方：每分区 ≥100MB；行组 100K–1M 行。
- 第三方专文：[The Small Files Trap in DuckDB (Fix It Early)](https://medium.com/@jickpatel611/the-small-files-trap-in-duckdb-fix-it-early-eea7b239d16e) —— 建议提前做 compaction、控制行组、注意排序与分区策略。
- 实测参考数据点：1000 行单文件 = 4939 bytes（即约 5KB）。**如果每批只导入几百行，日积月累会产生大量 KB 级文件**，需要定期 compaction。

**给 bi-lite 的推荐落地：**

1. 导入只写 Parquet：`/data/batches/<dataset>/dt=YYYY-MM-DD/batch_<uuid>.parquet`，写入用 `tmp` 名 + 原子 rename。
2. 批次文件按需 compaction：当某分区文件数 > N 或平均文件 < 10MB 时，合并成 100K–1M 行的 row group。
3. 查询统一走 `read_parquet('.../dt=*/*.parquet', hive_partitioning=true, union_by_name=true)`；用 `filename` 虚拟列做来源追溯。
4. 单批行数少（<10 万行）时，先积累到阈值再落盘，避免小文件。
5. 若需要 DuckDB 库文件做加速层，由**单进程**持有，并用 `SetMaxOpenConns(1)` 等价做法（Node 侧限制只用一个 connection 做写）。

---

# 附：本次调研的实证脚本位置（供复核）

| 路径 | 内容 |
|---|---|
| `/tmp/bire/xl/make_template.py` | openpyxl 生成全特性模板 `template.xlsx`（合并/样式/数字格式/条件格式×4/数据验证×2/公式/图表/图片/批注/冻结/打印区/定义名称） |
| `/tmp/bire/xl/make_variants.py` | 逐特性隔离变体：`t_base`/`t_safe`/`t_comment`/`t_chart`/`t_image`/`t_nodrawing`/`t_rich` |
| `/tmp/bire/xltest/final.mjs` | exceljs 崩溃矩阵（template/t_comment/t_chart/t_safe） |
| `/tmp/bire/xltest/xp.mjs` | xlsx-populate 全特性 round-trip |
| `/tmp/bire/xltest/xt3.mjs`、`xt4.mjs` | xlsx-template 1.4.7 substitute/generate 与 sharedStrings 缺失崩溃 |
| `/tmp/bire/xlxml/fill.mjs` | 直接打 XML 补丁的实现（unzip→替换 `<c>`→zip） |
| `/tmp/bire/xltest/rt.mjs` | exceljs 数据验证重复问题复现 |
| `/tmp/bire/x14/` | 现代 Excel 扩展（x14 数据条/图标集/迷你图）保真测试，产物 `t_x14`/`t_ext`/`t_dual` 与各库输出 |
| `/tmp/bire/xltest/b1.mjs`、`b1ro.mjs`、`cfg.mjs` | node-api API 表面、READ_ONLY、Parquet、配置项枚举 |
| `/tmp/bire/xltest/b2*.mjs`、`/tmp/bire/cx/{holder,reader}.mjs` | 单写者并发矩阵、跨进程 ATTACH 测试 |
| `/tmp/bire/xltest/b156.mjs`、`pq2.mjs` | Parquet 分区/glob/union_by_name、staging 模式 |
| `/tmp/bire/xltest/sqlite2.mjs` | DuckDB sqlite 扩展双向读写 |
| `/tmp/bire/xltest/ext.mjs`、`dual.mjs`、`x14.mjs` | 三库对现代 Excel 扩展的处理对比 |
