import { ZENODO_LICENSE_URLS } from '../zenodo/licenses.js';

/** A licence's address, by its Zenodo ID (`cc-by-4.0`), where Zenodo's vocabulary gives one. */
export function licenseUrlOf(license: string | undefined): string | undefined {
  return license ? ZENODO_LICENSE_URLS[license.toLowerCase()] : undefined;
}

/** A Creative Commons licence or dedication: the work is free to read under it. */
export function isOpenLicense(license: string | undefined): boolean {
  return /^cc(0|-by)/u.test(license?.toLowerCase() ?? '');
}
