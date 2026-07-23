import { generateToken } from '../lib/auth/jwt'

// Generate a test token for debugging
const testPayload = {
  userId: 'test-user-123',
  email: 'test@backenly.com',
  name: 'Test User',
  role: 'admin'
}

const token = generateToken(testPayload)
console.log('Generated test token:')
console.log(token)
console.log('\nUse this in your requests as:')
console.log(`Authorization: Bearer ${token}`)