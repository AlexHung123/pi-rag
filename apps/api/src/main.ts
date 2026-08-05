import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import cookieParser = require('cookie-parser');
import { AppModule } from './app.module';
import { AuthService } from './auth/auth.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: false });
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';
  app.enableCors({
    origin: corsOrigin.split(',').map((s) => s.trim()),
    credentials: true,
  });

  const auth = app.get(AuthService);
  await auth.bootstrapAdminIfNeeded();

  const port = Number(process.env.PORT || 3001);
  // Bind all interfaces so Vite proxy via 127.0.0.1 always works on Windows
  await app.listen(port, '0.0.0.0');
  Logger.log(
    `CSB Knowledge Base Portal API listening on http://127.0.0.1:${port}`,
    'Bootstrap',
  );
}

bootstrap();
