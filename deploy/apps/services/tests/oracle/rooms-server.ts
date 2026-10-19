// Fixture-only Bun oracle; never copied into a production image.
import { app } from './rooms'
app.listen({port: Number(process.env.PORT),hostname:'127.0.0.1'})
