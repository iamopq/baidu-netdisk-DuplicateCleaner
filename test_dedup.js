// 临时测试：验证 userscript 中的纯函数（HTML 转义 / CSV 往返 / 勾选优先级 / 分组）
const fs = require('fs');
const src = fs.readFileSync('baidu_netdisk_dedup.user.js', 'utf8');

function slice(fromMark, toMark) {
  const a = src.indexOf(fromMark);
  if (a < 0) throw new Error('未找到起点: ' + fromMark);
  let b = src.indexOf(toMark, a);
  if (b < 0) throw new Error('未找到终点: ' + toMark);
  b = src.lastIndexOf('/*', b);            // 回退到注释块起始，避免留下未闭合注释
  return src.slice(a, b > a ? b : src.length);
}

const partTools = slice('function fmtSize', 'bdstoken：多策略级联');
const partState = slice('function buildIndexes', '* UI');

const harness = 'var state = { files: [], groups: null, allPaths: new Map(), selected: new Set(),' +
  ' overrides: new Map(), view: [], page: 1, pageSize: 50, filter: "", sort: "size", totalFiles: 0,' +
  ' roots: "", criteria: "name+size", snapshotAt: null };\n';

const M = new Function(harness + partTools + '\n' + partState +
  '\n return {fmtSize, baseName, escapeHtml, csvCell, csvRow, parseCSV, buildIndexes, resetDefaultSelection,' +
  ' effectiveSelected, buildView, selectedStat, buildCSV, buildAllCSV, buildAllJSON,' +
  ' allFilesSorted, buildDupMark, state};')();

let pass = 0, fail = 0;
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n      expected: ' + JSON.stringify(expected) + '\n      actual  : ' + JSON.stringify(actual)); }
}
function reset() {
  M.state.files = []; M.state.groups = null; M.state.allPaths = new Map();
  M.state.selected = new Set(); M.state.overrides = new Map();
  M.state.filter = ''; M.state.sort = 'size'; M.state.page = 1; M.state.pageSize = 50;
}

console.log('--- escapeHtml（属性断言，不依赖字面实体）---');
const raw = '<a href="x">&\'</a>';
const out = M.escapeHtml(raw);
check('输出不含裸 < ', out.indexOf('<') === -1, true);
check('输出不含裸 > ', out.indexOf('>') === -1, true);
check('输出不含裸双引号', out.indexOf('"') === -1, true);
check('输出不含裸单引号', out.indexOf("'") === -1, true);
check('每个 & 都构成合法实体', /&(?!(?:amp|lt|gt|quot|#39);)/.test(out), false);
check('普通中文文件名不被破坏', M.escapeHtml('生命的宇宙.pdf'), '生命的宇宙.pdf');
check('确实发生了转义', out.length > raw.length, true);

console.log('--- fmtSize ---');
check('0 B', M.fmtSize(0), '0 B');
check('1024 -> 1.00 KB', M.fmtSize(1024), '1.00 KB');
check('28445923 -> 27.13 MB', M.fmtSize(28445923), '27.13 MB');
check('null -> -', M.fmtSize(null), '-');

console.log('--- csvCell / CSV 往返（路径含逗号/引号/换行）---');
check('含逗号需加引号', M.csvCell('a,b'), '"a,b"');
check('含双引号需转义', M.csvCell('say "hi"'), '"say ""hi"""');
check('含换行需加引号', M.csvCell('a\nb'), '"a\nb"');
check('普通值不加引号', M.csvCell('正常'), '正常');
const rows = [
  ['组号', '文件路径', '删除标记'],
  [1, '/示例目录/a,b/"引号"/文件.pdf', '1'],
  [2, '/佛道/心流\n换行.pdf', '']
];
const csv = rows.map(r => r.map(M.csvCell).join(',')).join('\r\n');
const parsed = M.parseCSV(csv);
check('含逗号+引号路径还原', parsed[1][1], '/示例目录/a,b/"引号"/文件.pdf');
check('含换行路径还原', parsed[2][1], '/佛道/心流\n换行.pdf');
check('BOM 被剥离', M.parseCSV('\uFEFF' + csv)[0][0], '组号');

console.log('--- 分组与默认勾选 ---');
reset();
M.state.files = [
  { path: '/a/书A.pdf', name: '书A.pdf', size: 100, md5: 'm1' },
  { path: '/b/书A.pdf', name: '书A.pdf', size: 100, md5: 'm1' },
  { path: '/c/书A.pdf', name: '书A.pdf', size: 100, md5: 'm1' },
  { path: '/a/书B.pdf', name: '书B.pdf', size: 200, md5: 'm2' },
  { path: '/a/书C.pdf', name: '书C.pdf', size: 300, md5: 'm3' }
];
// analyze 位于网络请求段（未纳入提取），这里直接构造等价分组
M.state.groups = {
  '书A.pdf|100': M.state.files.slice(0, 3),
  '书B.pdf|200': [M.state.files[3]]
};
M.buildIndexes();
M.resetDefaultSelection();
check('默认勾选：3 副本组勾 2 个', Array.from(M.state.selected).sort(), ['/b/书A.pdf', '/c/书A.pdf']);
check('单副本组不勾选', M.state.selected.has('/a/书B.pdf'), false);

console.log('--- 手动决定(overrides)优先级高于默认 ---');
M.state.overrides.set('/b/书A.pdf', false);           // 用户手动取消
M.state.overrides.set('/a/书A.pdf', true);            // 用户手动勾上本该保留的第一份
const eff = M.effectiveSelected();
check('手动取消的不会被选中', eff.has('/b/书A.pdf'), false);
check('手动勾选的覆盖默认保留', eff.has('/a/书A.pdf'), true);
check('未干预的沿用默认', eff.has('/c/书A.pdf'), true);
check('有效勾选总数', eff.size, 2);
const st = M.selectedStat();
check('合计大小 = 100+100', st.bytes, 200);

console.log('--- 导出 CSV 的删除标记反映有效勾选 ---');
reset();
M.state.files = [
  { path: '/a/书A.pdf', name: '书A.pdf', size: 100, md5: 'm1' },
  { path: '/b/书A.pdf', name: '书A.pdf', size: 100, md5: 'm1' }
];
M.state.groups = { g1: M.state.files };
M.buildIndexes(); M.resetDefaultSelection();
M.state.overrides.set('/b/书A.pdf', false);   // 两份都保留
const csvOut = M.parseCSV(M.buildCSV());
const delCol = csvOut[0].findIndex(h => String(h).includes('删除标记'));
check('表头含删除标记列', delCol >= 0, true);
check('第一份标记为保留(空)', csvOut[1][delCol], '');
check('被手动取消的第二份也为空', csvOut[2][delCol], '');
M.state.overrides.clear();
const csvOut2 = M.parseCSV(M.buildCSV());
check('清除手动决定后第二份标记为 1', csvOut2[2][delCol], '1');

console.log('--- 导出全部文件清单（新增）---');
reset();
M.state.files = [
  { path: '/示例目录/书A.pdf', name: '书A.pdf', size: 100, md5: 'm1' },
  { path: '/示例目录/子目录/书A.pdf', name: '书A.pdf', size: 100, md5: 'm1' },
  { path: '/佛道/心流.pdf', name: '心流.pdf', size: 2048, md5: 'm2' }
];
M.state.groups = { g1: [M.state.files[0], M.state.files[1]] };
M.buildIndexes(); M.resetDefaultSelection();

const allCsv = M.parseCSV(M.buildAllCSV());
check('表头首列', allCsv[0][0], '序号');
check('表头含所在目录', allCsv[0].indexOf('所在目录') >= 0, true);
check('表头含是否重复', allCsv[0].indexOf('是否重复') >= 0, true);
check('行数 = 表头 + 3 个文件', allCsv.length, 4);
const cPath = allCsv[0].indexOf('文件路径');
const cDir = allCsv[0].indexOf('所在目录');
const cDup = allCsv[0].indexOf('是否重复');
const cGrp = allCsv[0].indexOf('重复组号');
check('按路径排序：第1行是 /佛道/心流.pdf', allCsv[1][cPath], '/佛道/心流.pdf');
check('所在目录解析正确', allCsv[1][cDir], '/佛道');
check('非重复文件 是否重复 为空', allCsv[1][cDup], '');
check('重复文件标注「是」', allCsv[2][cDup], '是');
check('重复文件标注组号 1', allCsv[2][cGrp], '1');
check('第3个重复副本组号同为 1', allCsv[3][cGrp], '1');

const allJson = JSON.parse(M.buildAllJSON());
check('JSON total 正确', allJson.total, 3);
check('JSON rows 数', allJson.rows.length, 3);
check('JSON 首行按路径排序', allJson.rows[0].path, '/佛道/心流.pdf');
check('JSON dir 正确', allJson.rows[0].dir, '/佛道');
check('JSON 重复标记', allJson.rows[1].dup, true);
check('JSON 非重复标记', allJson.rows[0].dup, false);
check('JSON 组号', allJson.rows[1].group, 1);
check('JSON sizeText', allJson.rows[0].sizeText, '2.00 KB');

console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
