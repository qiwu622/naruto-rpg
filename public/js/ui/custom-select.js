const REFRESH_EVENT = 'neo-select:refresh';

export function refreshCustomSelect(select) {
  if (!select?.dispatchEvent) return;
  select.dispatchEvent(new Event(REFRESH_EVENT));
}

export function bindCustomSelects(root) {
  // 1. Inject styles if not present
  const styleId = 'neo-wafu-select-style';
  if (!root.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .ns-select-wrapper {
        position: relative;
        width: 100%;
        user-select: none;
        font-family: inherit;
        font-size: 13px;
      }
      .ns-select-trigger {
        width: 100%;
        min-height: 38px;
        box-sizing: border-box;
        background: var(--ui-surface-2, #181d26);
        color: var(--ui-ink, #f0ece2);
        border: 1px solid var(--ui-border, rgba(244,241,234,0.12));
        border-radius: 8px;
        padding: 8px 34px 8px 12px;
        cursor: pointer;
        display: flex;
        align-items: center;
        transition: border-color 0.16s ease, box-shadow 0.16s ease, background 0.16s ease;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ns-select-trigger:hover {
        border-color: var(--ui-border-strong, rgba(244,241,234,0.22));
      }
      .ns-select-trigger::after {
        content: '';
        position: absolute;
        right: 13px;
        top: 50%;
        width: 6px;
        height: 6px;
        border-right: 1.6px solid var(--ui-ink-muted, #aba69b);
        border-bottom: 1.6px solid var(--ui-ink-muted, #aba69b);
        transform: translateY(-65%) rotate(45deg);
        transition: transform 0.2s ease, border-color 0.2s ease;
      }
      .ns-select-wrapper.open .ns-select-trigger {
        border-color: var(--ui-accent, #eb613f);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-accent, #eb613f) 16%, transparent);
        background: var(--ui-surface-elevated, #1e2430);
      }
      .ns-select-wrapper.open .ns-select-trigger::after {
        border-color: var(--ui-accent, #eb613f);
        transform: translateY(-30%) rotate(-135deg);
      }
      .ns-select-dropdown {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        right: 0;
        background: var(--ui-surface-elevated, #1e2430);
        border: 1px solid var(--ui-border-strong, rgba(244,241,234,0.20));
        border-radius: 8px;
        box-shadow: var(--ui-shadow, 0 12px 32px rgba(0,0,0,0.45));
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        z-index: 1000;
        max-height: 260px;
        overflow-y: auto;
        opacity: 0;
        visibility: hidden;
        transform: translateY(-4px);
        transition: opacity 0.18s cubic-bezier(0.16, 1, 0.3, 1), transform 0.18s cubic-bezier(0.16, 1, 0.3, 1), visibility 0.18s;
        scrollbar-width: thin;
        scrollbar-color: var(--ui-border-strong, rgba(244,241,234,0.20)) transparent;
      }
      .ns-select-dropdown::-webkit-scrollbar { width: 4px; }
      .ns-select-dropdown::-webkit-scrollbar-thumb { background: var(--ui-border-strong, rgba(244,241,234,0.20)); border-radius: 2px; }
      .ns-select-wrapper.open .ns-select-dropdown {
        opacity: 1;
        visibility: visible;
        transform: translateY(0);
      }
      .ns-select-option {
        padding: 9px 14px;
        color: var(--ui-ink-muted, #aba69b);
        cursor: pointer;
        transition: background 0.14s ease, color 0.14s ease;
        position: relative;
      }
      .ns-select-option:hover {
        background: color-mix(in srgb, var(--ui-ink, #f0ece2) 5%, transparent);
        color: var(--ui-ink, #f0ece2);
      }
      .ns-select-option.selected {
        color: var(--ui-ink, #f0ece2);
        font-weight: 600;
        background: color-mix(in srgb, var(--ui-accent, #eb613f) 10%, transparent);
      }
      .ns-select-option.selected::before, .ns-select-option:hover::before {
        content: '';
        position: absolute;
        left: 0; top: 4px; bottom: 4px; width: 2.5px; border-radius: 9px;
        background: var(--ui-accent, #eb613f);
        opacity: 0;
        transition: opacity 0.16s;
      }
      .ns-select-option:hover::before { opacity: 0.45; }
      .ns-select-option.selected::before { opacity: 1; }
    `;
    if (root.prepend) {
      root.prepend(style);
    } else if (root.head) {
      root.head.appendChild(style);
    }
  }

  // 2. Find all selects that are not yet bound
  const selects = root.querySelectorAll('select:not([data-ns-bound])');
  
  selects.forEach(select => {
    select.setAttribute('data-ns-bound', 'true');
    select.style.display = 'none'; // Hide native select

    const wrapper = document.createElement('div');
    wrapper.className = 'ns-select-wrapper';
    
    const trigger = document.createElement('div');
    trigger.className = 'ns-select-trigger';
    
    const dropdown = document.createElement('div');
    dropdown.className = 'ns-select-dropdown';

    // Insert into DOM
    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(select);
    wrapper.appendChild(trigger);
    wrapper.appendChild(dropdown);

    const renderOptions = () => {
      dropdown.innerHTML = '';
      let selectedText = '';
      
      Array.from(select.options).forEach((option, index) => {
        const item = document.createElement('div');
        item.className = 'ns-select-option';
        item.textContent = option.text;
        
        if (option.selected) {
          item.classList.add('selected');
          selectedText = option.text;
        }

        item.addEventListener('click', (e) => {
          e.stopPropagation();
          select.selectedIndex = index;
          trigger.textContent = option.text;
          closeDropdown();
          
          // Trigger change event on native select
          const event = new Event('change', { bubbles: true, cancelable: true });
          select.dispatchEvent(event);
        });

        dropdown.appendChild(item);
      });

      trigger.textContent = selectedText || (select.options.length > 0 ? select.options[0].text : '');
    };

    const openDropdown = () => {
      renderOptions();
      wrapper.classList.add('open');
      
      // Calculate position so it doesn't overflow
      const rect = wrapper.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const dropdownHeight = Math.min(dropdown.scrollHeight + 2, 260);
      if (rect.bottom + dropdownHeight + 4 > viewportHeight && rect.top >= dropdownHeight + 4) {
        dropdown.style.top = 'auto';
        dropdown.style.bottom = 'calc(100% + 4px)';
      } else {
        dropdown.style.top = 'calc(100% + 4px)';
        dropdown.style.bottom = 'auto';
      }
    };

    const closeDropdown = () => {
      wrapper.classList.remove('open');
    };

    renderOptions();

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (wrapper.classList.contains('open')) {
        closeDropdown();
      } else {
        root.querySelectorAll('.ns-select-wrapper.open').forEach(el => {
          if (el !== wrapper) el.classList.remove('open');
        });
        openDropdown();
      }
    });

    select.addEventListener('change', renderOptions);
    select.addEventListener(REFRESH_EVENT, renderOptions);

    document.addEventListener('click', (e) => {
      if (wrapper.classList.contains('open') && !wrapper.contains(e.target)) {
        const path = e.composedPath ? e.composedPath() : [e.target];
        if (!path.includes(wrapper)) {
          closeDropdown();
        }
      }
    });
  });
}
