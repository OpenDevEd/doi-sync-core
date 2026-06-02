import { describe, expect, it } from 'vitest';
import { buildCrossrefDepositRequest } from '../crossref/deposit.js';

describe('Crossref deposit request', () => {
  it('uses the documented multipart field names without executing a network request', () => {
    const request = buildCrossrefDepositRequest({
      environment: 'test',
      loginId: 'user@example.org/odel',
      password: 'secret',
      filename: 'record.xml',
      xml: '<doi_batch />'
    });

    expect(request).toEqual({
      endpoint: 'https://test.crossref.org/servlet/deposit',
      method: 'POST',
      fields: {
        operation: 'doMDUpload',
        login_id: 'user@example.org/odel',
        login_passwd: 'secret',
        fname: {
          filename: 'record.xml',
          contentType: 'application/xml',
          body: '<doi_batch />'
        }
      }
    });
  });
});
