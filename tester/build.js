const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const t = path.join(__dirname);
const out = execFileSync('npx', ['--yes', 'esbuild', path.join(t, 'src/app.jsx'), '--jsx=transform', '--minify', '--target=firefox115'], { shell: true, encoding: 'utf8', maxBuffer: 1 << 26 });
const lib = (f) => fs.readFileSync(path.join(t, 'vendor', f), 'utf8').replace(/<\/script/gi, '<\\/script');
const scripts = [lib('react.production.min.js'), lib('react-dom.production.min.js'), out.replace(/<\/script/gi, '<\\/script')]
  .map((s) => '<script>' + s + '</script>').join('\n');
const tpl = fs.readFileSync(path.join(t, 'src/template.html'), 'utf8');
const icon = 'data:image/svg+xml,' + encodeURIComponent(fs.readFileSync(path.join(t, '../extension/icon.svg'), 'utf8').replace(/\s*\n\s*/g, ''));
fs.writeFileSync(path.join(t, 'index.html'), tpl.replace('%%ICON%%', () => icon).replace('<!--SCRIPTS-->', () => scripts));
console.log('built index.html', fs.statSync(path.join(t, 'index.html')).size, 'bytes');

