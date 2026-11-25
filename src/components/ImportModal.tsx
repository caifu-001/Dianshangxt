import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import Papa from 'papaparse'
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Upload } from 'lucide-react'
import { Button, Modal, Select, useToast } from './ui'
import { downloadTextFile, num } from '../lib/utils'

export interface ImportField {
  key: string
  label: string
  aliases: string[]
  required?: boolean
  numeric?: boolean
  hint?: string
}

export function ImportModal({
  open,
  onClose,
  title = '批量导入',
  fields,
  onImport,
  note,
  extra,
}: {
  open: boolean
  onClose: () => void
  title?: string
  fields: ImportField[]
  onImport: (rows: Array<Record<string, string>>) => Promise<void>
  note?: string
  extra?: ReactNode
}) {
  const { push } = useToast()
  const [raw, setRaw] = useState<Array<Record<string, string>>>([])
  const [fileName, setFileName] = useState('')
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [importing, setImporting] = useState(false)

  const headers = useMemo(() => (raw.length ? Object.keys(raw[0]) : []), [raw])

  function reset() {
    setRaw([])
    setFileName('')
    setMapping({})
  }

  function handleFile(file: File) {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.trim(),
      complete: (result) => {
        const rows = (result.data ?? []).filter((r) => Object.values(r).some((v) => String(v ?? '').trim() !== ''))
        if (!rows.length) {
          push('文件里没有解析到数据行', 'error')
          return
        }
        const cols = Object.keys(rows[0])
        const auto: Record<string, string> = {}
        for (const f of fields) {
          const hit = cols.find((c) =>
            f.aliases.some((a) => c.toLowerCase().replace(/[\s_-]/g, '') === a.toLowerCase().replace(/[\s_-]/g, '')),
          )
          if (hit) auto[f.key] = hit
        }
        setRaw(rows)
        setFileName(file.name)
        setMapping(auto)
      },
      error: () => push('文件解析失败，请确认是 CSV 格式', 'error'),
    })
  }

  const mapped = useMemo(() => {
    return raw
      .map((row) => {
        const out: Record<string, string> = {}
        for (const f of fields) {
          const col = mapping[f.key]
          out[f.key] = col ? String(row[col] ?? '').trim() : ''
        }
        return out
      })
      .filter((row) => Object.values(row).some((v) => v !== ''))
  }, [raw, mapping, fields])

  const missing = fields.filter((f) => f.required && !mapping[f.key])

  async function handleImport() {
    if (missing.length) {
      push(`请先匹配必填列：${missing.map((m) => m.label).join('、')}`, 'error')
      return
    }
    setImporting(true)
    try {
      await onImport(mapped)
      reset()
      onClose()
    } catch (err) {
      push(err instanceof Error ? err.message : '导入失败', 'error')
    } finally {
      setImporting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset()
        onClose()
      }}
      title={title}
      description="支持 Excel 导出的 CSV 文件，列名可自动识别，也可手动指定"
      width="max-w-3xl"
      footer={
        <>
          <Button
            size="sm"
            icon={<Download className="w-3.5 h-3.5" />}
            onClick={() =>
              downloadTextFile(
                '导入模板.csv',
                [fields.map((f) => f.label).join(','), fields.map(() => '').join(',')].join('\n'),
                'text/csv;charset=utf-8',
              )
            }
          >
            下载模板
          </Button>
          <div className="flex-1" />
          <Button
            onClick={() => {
              reset()
              onClose()
            }}
          >
            取消
          </Button>
          <Button variant="primary" loading={importing} disabled={!raw.length} onClick={handleImport} icon={<Upload className="w-3.5 h-3.5" />}>
            导入 {mapped.length > 0 && `${mapped.length} 条`}
          </Button>
        </>
      }
    >
      {extra && <div className="mb-3">{extra}</div>}
      {!raw.length ? (
        <label className="flex flex-col items-center justify-center gap-2 py-12 border-2 border-dashed border-ink-200 rounded-xl cursor-pointer hover:border-brand-400 hover:bg-brand-50/30 transition-colors">
          <FileSpreadsheet className="w-8 h-8 text-ink-300" />
          <p className="text-[13px] font-medium text-ink-700">点击选择 CSV 文件</p>
          <p className="text-[11.5px] text-ink-400">支持 UTF-8 编码，首行为表头</p>
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) handleFile(file)
              e.target.value = ''
            }}
          />
        </label>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-[12px] text-ink-600">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            <span className="font-medium">{fileName}</span>
            <span className="text-ink-400">
              解析 {num(raw.length)} 行 · 有效 {num(mapped.length)} 行
            </span>
            <button className="ml-auto text-[11.5px] link" onClick={reset}>
              重新选择
            </button>
          </div>

          <div>
            <p className="label mb-2">列对应关系</p>
            <div className="grid sm:grid-cols-2 gap-2.5">
              {fields.map((f) => (
                <div key={f.key} className="flex items-center gap-2">
                  <span className="w-[92px] shrink-0 text-[11.5px] text-ink-600">
                    {f.label}
                    {f.required && <span className="text-rose-500">*</span>}
                  </span>
                  <Select
                    className="flex-1"
                    value={mapping[f.key] ?? ''}
                    onChange={(v) => setMapping((m) => ({ ...m, [f.key]: v }))}
                    placeholder="— 不导入 —"
                    options={headers.map((h) => ({ value: h, label: h }))}
                  />
                </div>
              ))}
            </div>
          </div>

          {missing.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-600 mt-0.5" />
              <p className="text-[11.5px] text-amber-800">必填列未匹配：{missing.map((m) => m.label).join('、')}</p>
            </div>
          )}

          <div>
            <p className="label mb-2">数据预览（前 5 行）</p>
            <div className="border border-ink-200 rounded-lg overflow-x-auto">
              <table className="w-full text-[11.5px]">
                <thead>
                  <tr className="bg-ink-50">
                    {fields.map((f) => (
                      <th key={f.key} className="px-2.5 py-1.5 text-left font-medium text-ink-500 whitespace-nowrap">
                        {f.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mapped.slice(0, 5).map((row, i) => (
                    <tr key={i} className="border-t border-ink-100">
                      {fields.map((f) => (
                        <td key={f.key} className="px-2.5 py-1.5 text-ink-700 max-w-[180px] truncate">
                          {row[f.key] || <span className="text-ink-300">—</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {note && <p className="text-[11px] text-ink-400 leading-relaxed">{note}</p>}
        </div>
      )}
    </Modal>
  )
}
