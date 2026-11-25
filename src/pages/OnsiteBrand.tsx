import { Link, useSearchParams } from 'react-router-dom'
import { ExternalLink, Megaphone, Users } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { PageHeader, Segmented } from '../components/ui'
import Ads from './Ads'
import Creators from './Creators'

type Tab = 'ads' | 'creators'

/**
 * 站内品牌营销：把原来的「广告投放」与「达人合作」收拢到同一模块，
 * 用标签切换；底层数据表与权限码保持不变，历史费用归集不受影响。
 */
export default function OnsiteBrand() {
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()

  const canAds = can('ads.view')
  const canCreators = can('creators.view')

  const requested = params.get('tab')
  const tab: Tab =
    requested === 'creators' && canCreators
      ? 'creators'
      : requested === 'ads' && canAds
        ? 'ads'
        : canAds
          ? 'ads'
          : 'creators'

  function setTab(next: Tab) {
    const q = new URLSearchParams(params)
    q.set('tab', next)
    setParams(q, { replace: true })
  }

  const options = [
    ...(canAds ? [{ value: 'ads', label: '广告投放' }] : []),
    ...(canCreators ? [{ value: 'creators', label: '达人合作' }] : []),
  ]

  return (
    <>
      <PageHeader
        title="站内品牌营销"
        description="站内广告投放与达人合作统一管理：广告活动、ACOS/ROAS 与 TikTok 达人建联带货，费用可一键归集到费用管理"
        actions={
          can('brand.view') ? (
            <Link to="/brand" className="btn btn-sm btn-default">
              <ExternalLink className="w-3.5 h-3.5" /> 站外品牌营销
            </Link>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <Segmented value={tab} onChange={(v) => setTab(v as Tab)} options={options} />
        <div className="flex items-center gap-3 text-[11px] text-ink-400">
          <span className="inline-flex items-center gap-1"><Megaphone className="w-3.5 h-3.5" /> 站内广告</span>
          <span className="inline-flex items-center gap-1"><Users className="w-3.5 h-3.5" /> TikTok 达人</span>
        </div>
      </div>

      {tab === 'ads' ? <Ads embedded /> : <Creators embedded />}
    </>
  )
}
