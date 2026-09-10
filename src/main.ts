import { RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { EmptyQueryValuePipe } from './common/validation/empty-query-value.pipe';
import { HttpExceptionFilter } from './common/errors/http-exception.filter';
import { createValidationPipe } from './common/validation/validation.pipe';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Matches the LLD's own REST surface exactly (§72: "GET /v1/messaging/discovery"
  // etc.) — /health/* stays unprefixed, the conventional fixed path a load
  // balancer/orchestrator expects.
  app.setGlobalPrefix('v1/messaging', {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });
  app.useGlobalPipes(new EmptyQueryValuePipe(), createValidationPipe());
  app.useGlobalFilters(new HttpExceptionFilter());
  // Mobile is a separate origin calling this API directly.
  app.enableCors();

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
}

bootstrap();
