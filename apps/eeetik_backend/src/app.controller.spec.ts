import { HealthController } from './health/health.controller';

describe('HealthController', () => {
  it('returns liveness status', () => {
    const controller = new HealthController();
    expect(controller.getLiveness()).toEqual({ status: 'ok' });
  });
});
