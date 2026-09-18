import { readFileSync } from 'node:fs'
const c = readFileSync('lib/index.js', 'utf8')
console.log('has MODULE LOADED:', c.includes('MODULE LOADED'))
