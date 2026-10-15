import { ConfigService } from '@nestjs/config';
import { DownloadRequestType } from '@shared';
import { AdGateService } from './ad-gate.service';

describe('AdGateService', () => {
  const configService = new ConfigService({
    AD_HD_MIN_SECONDS: '30',
    AD_SD_MIN_SECONDS: '15',
    AD_AUDIO_MIN_SECONDS: '10',
    AD_ZIP_MIN_SECONDS: '20',
  });
  const adGateService = new AdGateService(configService);

  it('accepts HD request with valid ad duration', () => {
    expect(() =>
      adGateService.assertAccess({
        uniqueId: 'u1',
        requestType: DownloadRequestType.HD,
        adToken: 'token',
        adDurationSeconds: 30,
      }),
    ).not.toThrow();
  });
});
