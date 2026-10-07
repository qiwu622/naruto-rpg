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
        box-sizing: border-box;
        background: rgba(255,255,255,0.02);
        color: var(--text-primary, #e8e4d9);
        border: 1px solid var(--border-subtle, rgba(255,255,255,0.1));
        border-radius: var(--r-sm, 4px);
        padding: 10px 32px 10px 12px;
        cursor: pointer;
        display: flex;
        align-items: center;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ns-select-trigger::after {
        content: '';
        position: absolute;
        right: 12px;
        top: 50%;
        transform: translateY(-50%);
        width: 8px;
        height: 5px;
        background-image: url("data:image/svg+xml,%3Csvg width='10' height='6'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%23ffffff' stroke-opacity='0.5' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-size: contain;
        transition: transform 0.2s ease;
      }
      .ns-select-wrapper.open .ns-select-trigger {
        border-color: rgba(255,255,255,0.3);
        background: rgba(255,255,255,0.05);
      }
      .ns-select-wrapper.open .ns-select-trigger::after {
        transform: translateY(-50%) rotate(180deg);
      }
      .ns-select-dropdown {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        right: 0;
        background: rgba(11, 14, 19, 0.95);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: var(--r-sm, 4px);
        box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        z-index: 1000;
        max-height: 260px;
        overflow-y: auto;
        opacity: 0;
        visibility: hidden;
        transform: translateY(-5px);
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,0.2) transparent;
      }
      .ns-select-dropdown::-webkit-scrollbar { width: 4px; }
      .ns-select-dropdown::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 2px; }
      .ns-select-wrapper.open .ns-select-dropdown {
        opacity: 1;
        visibility: visible;
        transform: translateY(0);
      }
      .ns-select-option {
        padding: 10px 16px;
        color: var(--text-secondary, #a39f98);
        cursor: pointer;
        transition: all 0.15s ease;
        position: relative;
      }
      .ns-select-option:hover {
        background: rgba(255,255,255,0.03);
        color: var(--text-primary, #e8e4d9);
      }
      .ns-select-option.selected {
        color: var(--text-primary, #e8e4d9);
        background: rgba(235, 97, 63, 0.04);
      }
      .ns-select-option.selected::before, .ns-select-option:hover::before {
        content: '';
        position: absolute;
        left: 0; top: 0; bottom: 0; width: 2px;
        background: var(--c-shuiro, #eb613f);
        opacity: 0;
        transition: opacity 0.2s;
      }
      .ns-select-option:hover::before { opacity: 0.5; }
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
