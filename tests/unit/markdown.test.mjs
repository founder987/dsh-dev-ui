/**
 * markdown 渲染单元测试：验证 renderMarkdownToHtml（lib/markdown.js 独立 bundle）
 * 运行：node tests/unit/markdown.test.mjs
 * 覆盖：标题/段落、表格（GFM）、任务列表、删除线、自动链接、HTML 转义安全
 */
import { renderMarkdownToHtml } from '../../lib/markdown.js';
import assert from 'node:assert/strict';

let passed = 0;
function check(name, actual, expect) {
  assert.ok(actual.includes(expect), `[${name}] 期望包含 ${JSON.stringify(expect)}，实际: ${JSON.stringify(actual.slice(0, 200))}`);
  passed += 1;
  console.log(`  ✅ ${name}`);
}

console.log('--- markdown 渲染测试 ---');

// 1. 标题与段落
check('标题', renderMarkdownToHtml('# 标题一\n\n正文'), '<h1>标题一</h1>');
check('段落', renderMarkdownToHtml('第一段\n\n第二段'), '<p>第二段</p>');

// 2. 表格（markdown-it default preset 支持）
const table = renderMarkdownToHtml('| a | b |\n|---|---|\n| 1 | 2 |');
check('表格', table, '<table>');
check('表格行', table, '<td>1</td>');

// 3. 任务列表（markdown-it-task-lists 插件）
const tasks = renderMarkdownToHtml('- [x] 完成项\n- [ ] 未完成项');
check('任务列表', tasks, 'checkbox');
check('勾选项', tasks, 'checked');

// 4. 删除线（markdown-it default 支持）
check('删除线', renderMarkdownToHtml('~~划掉~~'), '<s>划掉</s>');

// 5. 自动链接（linkify）
check('自动链接', renderMarkdownToHtml('访问 https://example.com 看看'), 'href="https://example.com"');

// 6. HTML 转义安全（html: false → 原始 HTML 不执行，按文本显示）
const html = renderMarkdownToHtml('<script>alert(1)</script>');
check('HTML 原文转义', html, '&lt;script&gt;');

// 7. 加粗/行内代码
check('加粗', renderMarkdownToHtml('**粗体**'), '<strong>粗体</strong>');
check('行内代码', renderMarkdownToHtml('`code`'), '<code>code</code>');

// 8. 空输入
assert.equal(renderMarkdownToHtml(''), '');
passed += 1;
console.log('  ✅ 空输入');

console.log(`\n全部通过：${passed} 项断言`);
