import { Hono } from 'hono'

const app = new Hono()

app.get('/', (c) => {
  return c.text('Initiating Otium')
})

export default app
