const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const messageHtml = (value) => escapeHtml(value).replace(/\r?\n/g, '<br>');

class GameModal extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  show({ title, content, buttons = [], onDismiss = null, wide = false }) {
    this._onDismiss = onDismiss;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; position: fixed; inset: 0; z-index: var(--z-modal-top); color: var(--text-primary, #e8e4d9); font-family: 'Noto Sans SC', 'Microsoft YaHei UI', 'PingFang SC', system-ui, sans-serif; }
        .overlay {
          position: fixed; inset: 0; z-index: 200000;
          display: flex; align-items: center; justify-content: center;
          background: rgba(7,10,14,0.72);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          animation: fi 0.16s ease;
          padding: 18px;
        }
        .modal {
          width: min(92vw, 480px);
          max-height: 88vh; overflow: auto;
          background:
            linear-gradient(180deg, rgba(232,228,217,0.035), transparent 118px),
            var(--surface-1, #10161d);
          border: 1px solid rgba(232,228,217,0.14);
          border-radius: 10px;
          padding: 0;
          box-shadow: 0 28px 80px rgba(0,0,0,0.52), 0 0 0 1px rgba(255,255,255,0.025) inset;
          animation: si 0.20s cubic-bezier(0.16,1,0.3,1);
          position: relative;
        }
        .modal.modal-wide { width: min(94vw, 820px); }
        .modal::before {
          content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
          border-radius: 10px 10px 0 0;
          background: linear-gradient(90deg, transparent, rgba(232,200,122,0.58), transparent);
        }
        @keyframes fi { from{opacity:0} to{opacity:1} }
        @keyframes si { from{opacity:0;transform:translateY(10px) scale(.985)} to{opacity:1;transform:translateY(0) scale(1)} }
        .title {
          padding: 22px 24px 14px;
          font-size: 18px;
          font-weight: 700;
          color: var(--text-primary, #e8e4d9);
          font-family:'Noto Serif SC','Source Han Serif SC','Songti SC','SimSun',serif;
          letter-spacing:1px;
        }
        .body {
          padding: 0 24px 22px;
          font-size: 13px;
          color: var(--text-secondary, #a39f98);
          line-height: 1.75;
        }
        .body p { margin: 0; }
        .btns {
          display: flex; gap: 10px; justify-content: flex-end;
          padding: 16px 24px;
          border-top: 1px solid rgba(232,228,217,0.08);
          background: rgba(7,10,14,0.22);
        }
        .btn {
          min-height: 36px;
          padding: 8px 16px; font-size: 13px; border-radius: 6px; cursor: pointer;
          border: 1px solid rgba(232,228,217,0.14);
          background: rgba(232,228,217,0.035);
          color: var(--text-primary, #e8e4d9);
          transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
          font-family:'Noto Sans SC','Microsoft YaHei UI','PingFang SC',system-ui,sans-serif; letter-spacing:0;
        }
        .btn:hover { border-color: rgba(232,228,217,0.24); background: rgba(232,228,217,0.065); }
        .btn:active { transform: translateY(1px); }
        .btn-p {
          background: linear-gradient(180deg, #f07452, #eb613f);
          border-color: rgba(235,97,63,0.68);
          color: #fff; font-weight: 700;
          box-shadow: 0 8px 20px rgba(0,0,0,0.22);
        }
        .btn-p:hover { background: linear-gradient(180deg, #eb613f, #c9171e); border-color:#c9171e; }
        @media (max-width: 480px) {
          .modal { width: 100%; }
          .title { padding: 20px 18px 12px; }
          .body { padding: 0 18px 20px; }
          .btns { padding: 14px 18px; flex-direction: column-reverse; }
          .btn { width: 100%; }
        }
      </style>
      <div class="overlay" id="mo">
        <div class="modal${wide ? ' modal-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="game-modal-title">
          <div class="title" id="game-modal-title">${escapeHtml(title)}</div>
          <div class="body">${content||''}</div>
          <div class="btns">${buttons.map((b,i)=>`<button type="button" class="btn${b.primary?' btn-p':''}" data-idx="${i}"${b.disabled ? ' disabled' : ''}>${escapeHtml(b.label)}</button>`).join('')}</div>
        </div>
      </div>
    `;
    this.shadowRoot.querySelector('#mo').addEventListener('click', (e) => { if (e.target.id === 'mo') this.close(); });
    this._onKeyDown = (e) => {
      if (e.key === 'Escape' && [...document.querySelectorAll('game-modal')].at(-1) === this) this.close();
    };
    document.addEventListener('keydown', this._onKeyDown);
    this.shadowRoot.querySelectorAll('.btn').forEach(b => {
      b.addEventListener('click', () => {
        const idx = parseInt(b.dataset.idx);
        buttons[idx]?.onClick?.();
        if (buttons[idx]?.close !== false) this.close();
      });
    });
    const autofocusIndex = buttons.findIndex(button => button.autofocus && !button.disabled);
    if (autofocusIndex >= 0) {
      requestAnimationFrame(() => this.shadowRoot.querySelector(`.btn[data-idx="${autofocusIndex}"]`)?.focus());
    }
  }

  close() {
    document.removeEventListener('keydown', this._onKeyDown);
    const onDismiss = this._onDismiss;
    this._onDismiss = null;
    this.shadowRoot.innerHTML = '';
    this.remove();
    onDismiss?.();
  }

  static confirm({ title, message, okLabel = '确定', cancelLabel = '取消' }) {
    return new Promise(resolve => {
      const m = new GameModal();
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      document.body.appendChild(m);
      m.show({
        title, content: `<p>${messageHtml(message)}</p>`, onDismiss: () => settle(false),
        buttons: [
          { label: cancelLabel, onClick: () => settle(false) },
          { label: okLabel, primary: true, onClick: () => settle(true) }
        ]
      });
    });
  }

  static alert({ title, message, okLabel = '确定' }) {
    return new Promise(resolve => {
      const m = new GameModal();
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve(true);
      };
      document.body.appendChild(m);
      m.show({
        title, content: `<p>${messageHtml(message)}</p>`, onDismiss: settle,
        buttons: [
          { label: okLabel, primary: true, onClick: settle }
        ]
      });
    });
  }

  static prompt({ title, message = '', value = '', placeholder = '', okLabel = '确定', cancelLabel = '取消', multiline = false, rows = 6 }) {
    return new Promise(resolve => {
      const m = new GameModal();
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      document.body.appendChild(m);
      const inputId = 'gm-input';
      const safeValue = escapeHtml(value);
      const safePlaceholder = escapeHtml(placeholder);
      const safeRows = Math.min(30, Math.max(1, Number(rows) || 6));
      const inputHtml = multiline
        ? `<textarea id="${inputId}" rows="${safeRows}" placeholder="${safePlaceholder}" style="width:100%;min-height:120px;resize:vertical;padding:10px 12px;background:rgba(7,10,14,0.6);border:1px solid rgba(232,228,217,0.18);border-radius:6px;color:var(--text-primary,#e8e4d9);font-family:'JetBrains Mono','Fira Code',monospace;font-size:12px;line-height:1.6;outline:none;">${safeValue}</textarea>`
        : `<input id="${inputId}" type="text" value="${safeValue}" placeholder="${safePlaceholder}" style="width:100%;padding:10px 12px;background:rgba(7,10,14,0.6);border:1px solid rgba(232,228,217,0.18);border-radius:6px;color:var(--text-primary,#e8e4d9);font-family:inherit;font-size:13px;outline:none;" />`;
      m.show({
        title,
        content: `<p style="margin:0 0 10px;">${messageHtml(message)}</p>${inputHtml}`,
        onDismiss: () => settle(null),
        buttons: [
          { label: cancelLabel, onClick: () => settle(null) },
          { label: okLabel, primary: true, onClick: () => settle(m.shadowRoot.getElementById(inputId)?.value ?? null) }
        ]
      });
      requestAnimationFrame(() => {
        const el = m.shadowRoot.getElementById(inputId);
        if (el) { el.focus(); el.select?.(); }
      });
    });
  }

  static choice({ title, message = '', choices = [], dismissValue = null, wide = false }) {
    return new Promise(resolve => {
      const modal = new GameModal();
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      document.body.appendChild(modal);
      modal.show({
        title,
        content: `<p>${messageHtml(message)}</p>`,
        wide,
        onDismiss: () => settle(dismissValue),
        buttons: choices.map(choice => ({
          label: choice.label,
          primary: choice.primary,
          autofocus: choice.autofocus,
          disabled: choice.disabled,
          onClick: () => settle(choice.value)
        }))
      });
    });
  }

  static variableRecovery({
    error = '', attempt = 1, canRepair = false, canApplySafe = false,
    safeAppliedCount = 0, safeDroppedCount = 0, unmetObligations = [],
    failureKind = '', repairStage = 'full', diagnosticId = ''
  } = {}) {
    const choices = [
      { label: '跳过变量并继续', value: { action: 'skip' } },
      ...(canApplySafe ? [{
        label: `安全保留 ${Math.max(0, Number(safeAppliedCount) || 0)} 项`,
        value: { action: 'apply-safe' }
      }] : []),
      { label: '重新生成变量', value: { action: 'regenerate' } },
      ...(canRepair ? [{ label: '调用 AI 修复', value: { action: 'repair' }, primary: true }] : [])
    ];
    const safeDetail = canApplySafe
      ? `本地校验器可安全保留 ${Math.max(0, Number(safeAppliedCount) || 0)} 项，并丢弃 ${Math.max(0, Number(safeDroppedCount) || 0)} 项无效标签。`
      : '本次没有可安全保留的变量标签。';
    const obligationDetail = Array.isArray(unmetObligations) && unmetObligations.length
      ? `\n仍未完成的更新义务：${unmetObligations.map(item => String(item || '').trim()).filter(Boolean).join('；')}`
      : '';
    const failureLabel = { daily: '日报校验', state: '变量校验', 'state-and-daily': '变量与日报校验',
      truncated: '输出截断', empty: '模型空回', transport: '模型连接' }[failureKind] || '二次变量演算';
    const repairDetail = repairStage === 'daily' ? '\n变量与记忆已通过校验，修复只重新生成日报。'
      : repairStage === 'state' ? '\n日报已通过校验，修复只重新生成变量与记忆。' : '';
    const diagnosticDetail = diagnosticId ? '\n可在调试面板的“变量更新结果”查看并导出本次失败原文。' : '';
    return GameModal.choice({
      title: `${failureLabel}异常 · 第 ${Math.max(1, Number(attempt) || 1)} 次`,
      message: `${String(error || '变量输出未通过校验')}\n\n${safeDetail}${obligationDetail}${repairDetail}${diagnosticDetail}\n“重新生成”会从本回合原始上下文重新演算；“调用 AI 修复”会携带被拒绝输出和校验错误，并保留已通过的部分。所有操作都在回合提交前完成；跳过后仍须通过回合提交检查，缺少必需产物时会回滚。直接关闭本窗口等同于选择跳过。`,
      choices,
      // Esc/backdrop is the universal "do nothing" gesture — it must never
      // write partial state; applying the safe subset requires a real click.
      dismissValue: { action: 'skip' },
      wide: true
    });
  }

  static reviewPreview({ displayText = '', error = '', attempt = 1 } = {}) {
    return new Promise(resolve => {
      const modal = new GameModal();
      let settled = false;
      const settle = result => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      document.body.appendChild(modal);
      const preview = String(displayText || '').trim();
      const errorText = String(error || '').trim();
      const body = errorText
        ? `<div style="padding:12px;border:1px solid rgba(239,83,80,.35);background:rgba(239,83,80,.08);color:#ef9a9a;border-radius:6px;">${messageHtml(errorText)}</div>`
        : `<div style="max-height:46vh;overflow:auto;padding:14px 16px;border:1px solid rgba(232,228,217,.12);background:rgba(7,10,14,.55);border-radius:6px;color:var(--text-primary,#e8e4d9);white-space:pre-wrap;line-height:1.8;">${messageHtml(preview)}</div>`;
      const feedback = `<label for="review-feedback" style="display:block;margin:14px 0 6px;color:#c6bda9;">若要重试，可填写修改意见</label><textarea id="review-feedback" rows="4" placeholder="例如：保留原稿第二段，只修正角色年龄与时间越界。" style="box-sizing:border-box;width:100%;resize:vertical;padding:10px 12px;background:rgba(7,10,14,.6);border:1px solid rgba(232,228,217,.18);border-radius:6px;color:var(--text-primary,#e8e4d9);font:12px/1.6 'Noto Sans SC',sans-serif;outline:none;"></textarea>`;
      const readFeedback = () => modal.shadowRoot.getElementById('review-feedback')?.value?.trim() || '';
      const buttons = [
        { label: '保留原稿', onClick: () => settle({ action: 'discard', feedback: '' }) },
        { label: '按意见重试', onClick: () => settle({ action: 'retry', feedback: readFeedback() }) },
        ...(!errorText && preview
          ? [{ label: '应用此预览', primary: true, onClick: () => settle({ action: 'apply', feedback: '' }) }]
          : [])
      ];
      modal.show({
        title: `正文复检预览 · 第 ${Math.max(1, Number(attempt) || 1)} 次`,
        content: `<p style="margin:0 0 12px;">此内容尚未写入状态、记忆或时间线。应用、继续修改，或保留原稿。</p>${body}${feedback}`,
        wide: true,
        onDismiss: () => settle({ action: 'discard', feedback: '' }),
        buttons
      });
    });
  }
}

customElements.define('game-modal', GameModal);
export default GameModal;
