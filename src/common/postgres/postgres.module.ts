import { Global, Module } from '@nestjs/common';
import { PostgresService } from './postgres.service';
import { UnitOfWork } from '../transactions/unit-of-work';

// @Global(): every module in this service needs a DB connection; re-providing
// it module-by-module would be pure boilerplate. Mirrors school-eos-backend's
// own PostgresModule for the same reason.
@Global()
@Module({
  providers: [PostgresService, UnitOfWork],
  exports: [PostgresService, UnitOfWork],
})
export class PostgresModule {}
