/**
 * 运行配置：全部读 Edge Function secrets，绝不写死在代码里。
 * 「资料暂时没有」时 isConfigured() 返回 false，
 * 各函数会返回明确的未配置提示，而不是崩溃或误同步。
 */

export const config = {
  supabaseUrl: Deno.env.get('SUPABASE_URL') ?? '',
  serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  anonKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',

  // Login with Amazon（公共应用凭证，审计通过后填入）
  lwaClientId: Deno.env.get('AMAZON_LWA_CLIENT_ID') ?? '',
  lwaClientSecret: Deno.env.get('AMAZON_LWA_CLIENT_SECRET') ?? '',
  // LWA 回调地址 = 本 callback 函数 URL，部署后填入
  redirectUri: Deno.env.get('AMAZON_REDIRECT_URI') ?? '',
  // 申请到的 scope，空格分隔（审计时按最小权限申请）
  scopes: Deno.env.get('AMAZON_SCOPES') ?? 'readorders readcatalog readinventory readfinancials',
  // AWS SigV4 签名凭证
  awsAccessKeyId: Deno.env.get('AWS_ACCESS_KEY_ID') ?? '',
  awsSecretAccessKey: Deno.env.get('AWS_SECRET_ACCESS_KEY') ?? '',
  awsSessionToken: Deno.env.get('AWS_SESSION_TOKEN') ?? '',
  awsRoleArn: Deno.env.get('AWS_ROLE_ARN') ?? '',

  // token 加密密钥（AES-GCM 256 位，base64；生成见 README）
  tokenEncryptionKey: Deno.env.get('TOKEN_ENCRYPTION_KEY') ?? '',
  // 定时任务的密钥（GitHub Actions 调 amazon-sync 时带 x-cron-secret）
  cronSecret: Deno.env.get('SYNC_CRON_SECRET') ?? '',
  // 回调后前端落地页（默认系统首页，可配自定义域名）
  frontendUrl: Deno.env.get('FRONTEND_URL') ?? 'https://kuahaishidai.dpdns.org',
}

export interface ConfigIssue {
  missing: string[]
}

/** 检查同步所需凭证是否齐备。缺哪几项一目了然。 */
export function checkSyncConfig(): ConfigIssue {
  const missing: string[] = []
  const need: Array<[string, string]> = [
    ['AMAZON_LWA_CLIENT_ID', config.lwaClientId],
    ['AMAZON_LWA_CLIENT_SECRET', config.lwaClientSecret],
    ['AMAZON_REDIRECT_URI', config.redirectUri],
    ['AWS_ACCESS_KEY_ID', config.awsAccessKeyId],
    ['AWS_SECRET_ACCESS_KEY', config.awsSecretAccessKey],
    ['AWS_ROLE_ARN', config.awsRoleArn],
    ['TOKEN_ENCRYPTION_KEY', config.tokenEncryptionKey],
  ]
  for (const [name, value] of need) if (!value) missing.push(name)
  return { missing }
}

export function isSyncConfigured(): boolean {
  return checkSyncConfig().missing.length === 0
}
