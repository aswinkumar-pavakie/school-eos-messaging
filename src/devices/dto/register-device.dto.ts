import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class RegisterDeviceDto {
  /** Base64url-encoded raw public key material for this device's identity --
   * paired separately with the E2EE identity key registration (e2ee module),
   * kept distinct here as the device's own registration credential (LLD
   * §13). */
  @IsString()
  @MinLength(1)
  devicePublicKey!: string;

  @IsIn(['ANDROID', 'IOS', 'WEB'])
  platform!: 'ANDROID' | 'IOS' | 'WEB';

  @IsOptional()
  @IsString()
  appVersion?: string;
}
