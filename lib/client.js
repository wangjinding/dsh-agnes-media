window.__ModuleLoader__.load({
  id: '@wangjinding/dsh-agnes-media',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const API = '/plugin/agnes-media';

    /* 用 DSH 自己的主题变量，跟随明暗主题 */
    const T = {
      text: 'var(--dsw-alias-label-primary, #1f2329)',
      sub: 'var(--dsw-alias-label-secondary, #646a73)',
      dim: 'var(--dsw-alias-label-tertiary, #8f959e)',
      line: 'var(--dsw-alias-border-l2, #dee0e3)',
      card: 'var(--dsw-alias-bg-layer-2, #ffffff)',
      field: 'var(--dsw-alias-bg-layer-1, #f7f8fa)',
      brand: 'var(--dsw-alias-brand-primary, #247bbf)',
      ok: 'var(--dsw-alias-state-success-primary, #2ea121)',
      err: 'var(--dsw-alias-state-error-primary, #f54a45)',
      warn: 'var(--dsw-alias-state-warn-primary, #ff8800)',
    };

    const css = {
      wrap: { padding: '4px 0 24px', color: T.text, fontSize: 14, lineHeight: 1.6 },
      h1: { fontSize: 17, fontWeight: 600, margin: '0 0 6px' },
      desc: { color: T.sub, margin: '0 0 18px', fontSize: 13 },
      card: {
        border: `1px solid ${T.line}`, borderRadius: 10, background: T.card,
        padding: 16, marginBottom: 14,
      },
      label: { display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 8, whiteSpace: 'nowrap', flexShrink: 0 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      input: {
        flex: '1 1 320px', minWidth: 220, height: 34, padding: '0 10px',
        borderRadius: 8, border: `1px solid ${T.line}`, background: T.field,
        color: T.text, fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        outline: 'none',
      },
      btn: {
        height: 34, padding: '0 14px', borderRadius: 8, cursor: 'pointer',
        border: `1px solid ${T.line}`, background: T.card, color: T.text, fontSize: 13,
      },
      primary: { border: `1px solid ${T.brand}`, background: T.brand, color: '#fff', fontWeight: 600 },
      danger: { border: `1px solid ${T.line}`, background: 'transparent', color: T.err },
      hint: { marginTop: 10, fontSize: 12, color: T.dim },
      status: {
        display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', flexShrink: 0,
        padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
      },
      bullet: { margin: '6px 0 0', paddingLeft: 18, color: T.sub, fontSize: 13 },
      pre: {
        margin: '10px 0 0', padding: 10, borderRadius: 8, background: T.field,
        fontSize: 12, color: T.sub, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      kbd: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        background: T.field, border: `1px solid ${T.line}`, borderRadius: 4,
        padding: '0 4px', fontSize: 12,
      },
    };

    async function call(path, init) {
      const resp = await fetch(`${API}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init && init.headers) },
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok || body.ok === false) {
        throw new Error(body.error || `HTTP ${resp.status}`);
      }
      return body;
    }

    function Badge({ configured }) {
      return h('span', {
        style: {
          ...css.status,
          background: configured ? 'rgba(46,161,33,.12)' : 'rgba(143,149,158,.14)',
          color: configured ? T.ok : T.dim,
        },
      }, h('span', {
        style: {
          width: 6, height: 6, borderRadius: 999,
          background: configured ? T.ok : T.dim, display: 'inline-block',
        },
      }), configured ? '已配置' : '未配置');
    }

    function AgnesPanel() {
      const [info, setInfo] = useState({ configured: false, source: '', masked: '' });
      const [key, setKey] = useState('');
      const [busy, setBusy] = useState('');
      const [msg, setMsg] = useState(null); // {kind:'ok'|'err', text, detail}
      const [models, setModels] = useState([]);

      const refresh = useCallback(async () => {
        try {
          const s = await call('/status', { method: 'GET' });
          setInfo({ configured: !!s.configured, source: s.source || '', masked: s.masked || '' });
        } catch (e) {
          setMsg({ kind: 'err', text: `读取状态失败：${e.message}` });
        }
      }, []);

      useEffect(() => { refresh(); }, [refresh]);

      const save = async () => {
        const v = key.trim();
        if (!v) { setMsg({ kind: 'err', text: '请先粘贴 API Key' }); return; }
        setBusy('save'); setMsg(null);
        try {
          const r = await call('/key', { method: 'POST', body: JSON.stringify({ apiKey: v }) });
          setKey('');
          setInfo({ configured: true, source: r.source || 'stored', masked: r.masked || '' });
          setModels(Array.isArray(r.models) ? r.models : []);
          setMsg({
            kind: 'ok',
            text: `已保存并验证通过（${r.latencyMs}ms，可见 ${(r.models || []).length} 个模型）`,
          });
        } catch (e) {
          setMsg({ kind: 'err', text: `保存失败：${e.message}` });
        } finally { setBusy(''); }
      };

      const test = async () => {
        setBusy('test'); setMsg(null);
        try {
          const r = await call('/test', { method: 'POST', body: '{}' });
          setModels(Array.isArray(r.models) ? r.models : []);
          setMsg({ kind: 'ok', text: `连接正常（${r.latencyMs}ms，可见 ${(r.models || []).length} 个模型）` });
        } catch (e) {
          setMsg({ kind: 'err', text: `测试失败：${e.message}` });
        } finally { setBusy(''); }
      };

      const clear = async () => {
        setBusy('clear'); setMsg(null);
        try {
          await call('/key', { method: 'DELETE' });
          setInfo({ configured: false, source: '', masked: '' });
          setModels([]);
          setMsg({ kind: 'ok', text: '已清除保存的密钥' });
        } catch (e) {
          setMsg({ kind: 'err', text: `清除失败：${e.message}` });
        } finally { setBusy(''); }
      };

      const media = models.filter((m) => /image|video/i.test(m));

      return h('div', { style: css.wrap },
        h('h1', { style: css.h1 }, 'Agnes 生成'),
        h('p', { style: css.desc },
          '配置 Agnes AI 的 API Key 后，DSH 就具备生图与生视频能力（工具：',
          h('code', { style: css.kbd }, 'agnes_generate_image'),
          ' / ',
          h('code', { style: css.kbd }, 'agnes_generate_video'),
          '）。密钥保存在 DSH 凭据库里，不写入配置文件。'),

        h('div', { style: css.card },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap', minWidth: 0 } },
            h('span', { style: css.label, marginBottom: 0 }, 'API Key'),
            h(Badge, { configured: info.configured }),
            info.configured && info.masked
              ? h('span', {
                  title: info.masked,
                  style: {
                    fontSize: 12, color: T.dim, fontFamily: 'monospace',
                    maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap', flexShrink: 1, minWidth: 0,
                  },
                }, info.masked)
              : null,
            info.configured && info.source
              ? h('span', { style: { fontSize: 12, color: T.dim } }, `来源：${info.source === 'stored' ? '凭据库' : info.source}`)
              : null),

          h('div', { style: css.row },
            h('input', {
              style: css.input,
              type: 'password',
              value: key,
              placeholder: info.configured ? '粘贴新的 Key 可替换现有的' : '粘贴 Agnes API Key（形如 sk-…）',
              autoComplete: 'off',
              spellCheck: false,
              onChange: (e) => setKey(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && !busy) save(); },
            }),
            h('button', {
              style: { ...css.btn, ...css.primary, opacity: busy ? 0.6 : 1 },
              disabled: !!busy, onClick: save,
            }, busy === 'save' ? '校验中…' : '保存并验证'),
            h('button', {
              style: { ...css.btn, opacity: busy ? 0.6 : 1 },
              disabled: !!busy || !info.configured, onClick: test,
            }, busy === 'test' ? '测试中…' : '测试连接'),
            h('button', {
              style: { ...css.btn, ...css.danger, opacity: busy ? 0.6 : 1 },
              disabled: !!busy || !info.configured, onClick: clear,
            }, '清除')),

          msg ? h('div', {
            style: {
              marginTop: 12, fontSize: 13,
              color: msg.kind === 'ok' ? T.ok : T.err,
            },
          }, msg.text) : null,

          media.length
            ? h('div', { style: css.pre }, media.slice(0, 12).join('\n'))
            : null,

          h('p', { style: css.hint },
            '保存时会把 Key 发给 Agnes 校验一次（GET /v1/models），通过后才落库。',
            '未配置时也可以先用环境变量 ',
            h('code', { style: css.kbd }, 'AGNES_API_KEY'),
            '，凭据库里的值优先。')),

        h('div', { style: css.card },
          h('div', { style: css.label }, '能做什么'),
          h('ul', { style: css.bullet },
            h('li', null, h('b', null, '生图'), '：agnes-image-2.5-flash，支持 1K/2K/3K/4K、8 种画幅、图生图与多图合成'),
            h('li', null, h('b', null, '生视频'), '：agnes-video-2.5-flash，720P，4–12 秒，支持文生视频、首尾帧、图片参考'),
            h('li', null, h('b', null, '落盘'), '：生成结果存到当前工作目录下的 ',
              h('code', { style: css.kbd }, 'agnes-media/'), '，工具会返回绝对路径')),
          h('p', { style: css.hint },
            '计费：图片按张、视频按秒，当前 Agnes 体验价多为 ¥0；实际以平台账单为准。')));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'agnes-media',
          order: 14,
          label: () => 'Agnes 生成',
          inject: () => ({}),
        }, AgnesPanel)), 'agnes-media: settings section');
      },
    };
  },
});
