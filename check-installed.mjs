import { readFileSync } from 'node:fs'
const path = 'E:\\htmlProjects\\deepseek-harness-master\\node_modules\\.pnpm\\node_modules\\@automatic-compress\\automatic-compress\\lib\\index.js'
const c = readFileSync(path, 'utf8')
const m = c.match(/static inject\s*=\s*\[([^\]]*)\]/)
console.log('inject:', m ? m[1] : 'NOT FOUND')
console.log('has console.error:', c.includes('console.error'))
console.log('has [automatic-compress]:', c.includes('[automatic-compress]'))
console.log('has sessionProjections in inject:', /inject\s*=\s*\[\s*['"]sessionProjections['"]/.test(c))
