import { generateGatewayToken } from '../auth.js'

const token = generateGatewayToken()
const name = process.argv[2] || 'client-1'

console.log(`\nAdd this to your config.yaml under auth.tokens:\n`)
console.log(`  - name: ${name}`)
console.log(`    token: ${token}`)
console.log(`\nClient should set:\n`)
console.log(`  ANTHROPIC_API_KEY=${token}`)
