export type CrossrefEnvironment = 'production' | 'test';

export interface CrossrefDepositRequestInput {
  readonly environment: CrossrefEnvironment;
  readonly loginId: string;
  readonly password: string;
  readonly filename: string;
  readonly xml: string;
}

export interface CrossrefDepositRequest {
  readonly endpoint: string;
  readonly method: 'POST';
  readonly fields: {
    readonly operation: 'doMDUpload';
    readonly login_id: string;
    readonly login_passwd: string;
    readonly fname: {
      readonly filename: string;
      readonly contentType: 'application/xml';
      readonly body: string;
    };
  };
}

export function buildCrossrefDepositRequest(input: CrossrefDepositRequestInput): CrossrefDepositRequest {
  return {
    endpoint: input.environment === 'production'
      ? 'https://doi.crossref.org/servlet/deposit'
      : 'https://test.crossref.org/servlet/deposit',
    method: 'POST',
    fields: {
      operation: 'doMDUpload',
      login_id: input.loginId,
      login_passwd: input.password,
      fname: {
        filename: input.filename,
        contentType: 'application/xml',
        body: input.xml
      }
    }
  };
}
