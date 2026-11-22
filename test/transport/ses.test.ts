import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSendEmailBody,
  classifySesError,
  laneFor,
  sendViaSes,
  type OutboundEmail,
  type SesLane,
  type TenantLanes,
} from '../../src/transport/ses';

const bulk: SesLane = {
  accessKeyId: 'AKIDBULK',
  secretAccessKey: 'bulk-secret',
  region: 'eu-west-1',
  configurationSet: 'tenant-a-bulk',
};
const transactional: SesLane = {
  accessKeyId: 'AKIDTX',
  secretAccessKey: 'tx-secret',
  region: 'eu-central-1',
  configurationSet: 'tenant-a-tx',
};

const email: OutboundEmail = {
  to: 'reader@example.com',
  from: 'Beacon <beacon@example.org>',
  subject: 'Issue 1',
  html: '<p>Hello</p>',
  text: 'Hello',
  unsubscribeUrl: 'https://openmail.test/u/tok123',
  tags: [{ name: 'campaign', value: 'c1' }],
};

describe('buildSendEmailBody', () => {
  it('builds SES v2 Simple content with the lane configuration set', () => {
    const body = buildSendEmailBody(email, bulk);

    expect(body.FromEmailAddress).toBe('Beacon <beacon@example.org>');
    expect(body.Destination).toEqual({ ToAddresses: ['reader@example.com'] });
    expect(body.ConfigurationSetName).toBe('tenant-a-bulk');
    expect(body.Content.Simple.Subject).toEqual({ Data: 'Issue 1', Charset: 'UTF-8' });
    expect(body.Content.Simple.Body).toEqual({
      Html: { Data: '<p>Hello</p>', Charset: 'UTF-8' },
      Text: { Data: 'Hello', Charset: 'UTF-8' },
    });
    expect(body.EmailTags).toEqual([{ Name: 'campaign', Value: 'c1' }]);
  });

  it('puts one-click unsubscribe headers inside Simple content, List-Unsubscribe first (RFC 8058)', () => {
    const body = buildSendEmailBody(email, bulk);

    expect(body).not.toHaveProperty('Headers');
    expect(body.Content.Simple.Headers).toEqual([
      { Name: 'List-Unsubscribe', Value: '<https://openmail.test/u/tok123>' },
      { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
    ]);
  });

  it('omits text, headers and tags when they are not given', () => {
    const body = buildSendEmailBody(
      { to: 'a@example.com', from: 'x@example.org', subject: 's', html: '<p>h</p>' },
      transactional,
    );

    expect(body.Content.Simple.Body).toEqual({ Html: { Data: '<p>h</p>', Charset: 'UTF-8' } });
    expect(body.Content.Simple).not.toHaveProperty('Headers');
    expect(body).not.toHaveProperty('EmailTags');
  });
});

describe('classifySesError', () => {
  it.each([
    [429, '', undefined, 'retryable', false],
    [500, '', undefined, 'retryable', false],
    [503, '', undefined, 'retryable', false],
    [400, '{"message":"Maximum sending rate exceeded."}', 'TooManyRequestsException', 'retryable', false],
    [400, '{"message":"Email address is on the suppression list"}', 'MessageRejected', 'non_retryable', true],
    [400, '{"message":"Email address is not verified."}', 'MessageRejected', 'non_retryable', false],
    [400, '{"message":"Sending paused"}', 'AccountSuspendedException', 'fatal', false],
    [400, '{"message":"Mail from domain not verified"}', 'MailFromDomainNotVerifiedException', 'fatal', false],
    [400, '{"message":"Missing final @domain"}', 'BadRequestException', 'non_retryable', true],
    [403, '{"message":"The security token included in the request is invalid."}', undefined, 'fatal', false],
    [418, '', undefined, 'retryable', false],
  ] as const)('status %i code %s → %s', (status, body, code, type, shouldSuppress) => {
    const result = classifySesError(status, body, code);

    expect(result.type).toBe(type);
    expect(result.shouldSuppress).toBe(shouldSuppress);
    expect(result.shouldRetry).toBe(type === 'retryable');
  });

  it('reads the error code from the x-amzn-ErrorType header form "Code:uri"', () => {
    const result = classifySesError(
      400,
      '{"message":"Email address is on the suppression list"}',
      'MessageRejected:http://internal.amazon.com/coral/com.amazonaws.sesv2/',
    );

    expect(result).toEqual({ type: 'non_retryable', shouldRetry: false, shouldSuppress: true });
  });
});

describe('laneFor', () => {
  const lanes: TenantLanes = { transactional, bulk };

  it('sends transactional mail on the transactional lane and campaigns on the bulk lane', () => {
    expect(laneFor(lanes, 'transactional')).toBe(transactional);
    expect(laneFor(lanes, 'bulk')).toBe(bulk);
  });
});

describe('sendViaSes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs a SigV4-signed request to the lane region and returns the message id', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"MessageId":"m-123"}', { status: 200 }));

    const result = await sendViaSes(bulk, email);

    expect(result).toEqual({ ok: true, messageId: 'm-123' });
    const request = fetchSpy.mock.calls[0]![0] as Request;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails');
    const auth = request.headers.get('authorization') ?? '';
    expect(auth).toContain('AWS4-HMAC-SHA256 Credential=AKIDBULK/');
    expect(auth).toContain('/eu-west-1/ses/aws4_request');
    expect(await request.json()).toEqual(buildSendEmailBody(email, bulk));
  });

  it('returns a classified failure when SES rejects the message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"message":"Email address is on the suppression list"}', {
        status: 400,
        headers: { 'x-amzn-ErrorType': 'MessageRejected:http://internal.amazon.com/' },
      }),
    );

    const result = await sendViaSes(transactional, email);

    expect(result).toEqual({
      ok: false,
      status: 400,
      type: 'non_retryable',
      shouldRetry: false,
      shouldSuppress: true,
      error: 'Email address is on the suppression list',
    });
  });

  it('treats a network failure as retryable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));

    const result = await sendViaSes(bulk, email);

    expect(result).toMatchObject({ ok: false, type: 'retryable', shouldRetry: true, shouldSuppress: false });
  });
});
