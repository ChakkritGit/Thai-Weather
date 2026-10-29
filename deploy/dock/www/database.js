// Dock's PostgreSQL browser. All database values are rendered as text, never HTML.
// The server owns authorization, masking, validation, audit, and query limits.
export async function databaseView(token, { h, tx, api, shell, topBar, tabs, handleError, fmtBytes, isCurrent }) {
  const body = h('div', { class: 'db-page' });
  shell(topBar(tx('ฐานข้อมูล'), { back: '#/more', onRefresh: () => refresh() }), body, tabs('#/more'));

  let databases = [];
  let tables = [];
  let database = '';
  let table = null;
  let offset = 0;
  let sort = '';
  let direction = 'asc';
  let search = '';
  let page = null;
  let editor = null;
  let showAudit = false;
  let audit = [];
  let showSQL = false;
  let sql = '';
  let sqlResult = null;
  let busy = false;
  let message = '';
  let sequence = 0;
  const limit = 50;
  const current = () => isCurrent(token);
  const request = (path, options) => api(`/database${path}`, options);
  const params = (values) => new URLSearchParams(Object.entries(values).filter(([, v]) => v !== '' && v != null)).toString();
  const small = (text) => h('p', { class: 'db-note' }, text);
  const button = (text, click, extra = {}) => h('button', { type: 'button', class: 'btn', onclick: click, ...extra }, text);
  const valueText = (value) => value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
  const fail = (err) => { if (!current()) return; handleError(err); };
  const identity = () => `${database} / ${table.schema}.${table.name}`;

  function selectDatabase() {
    const select = h('select', { class: 'field db-select', 'aria-label': tx('เลือกฐานข้อมูล'), onchange: async (event) => {
      database = event.target.value;
      table = null; page = null; editor = null; search = ''; sort = ''; offset = 0; showAudit = false; sqlResult = null;
      await loadTables();
    } }, databases.map((db) => h('option', { value: db.name, selected: db.name === database }, db.name)));
    return h('label', { class: 'db-field' }, h('span', {}, tx('ฐานข้อมูล')), select);
  }

  function render() {
    if (!current()) return;
    const content = [];
    if (databases.length) {
      content.push(selectDatabase());
      content.push(h('div', { class: 'db-links' },
        h('a', { class: 'db-link', href: '#/backup' }, tx('สำรองข้อมูลก่อนแก้ไข')),
        button(showSQL ? tx('กลับไปดูตาราง') : tx('คำสั่ง SQL'), () => {
          ++sequence; busy = false; showSQL = !showSQL; showAudit = false; editor = null; message = ''; render();
        }, { class: 'db-link' }),
        button(showAudit ? tx('กลับไปดูตาราง') : tx('ประวัติการแก้ไข'), async () => {
          ++sequence;
          busy = false;
          showAudit = !showAudit; showSQL = false; editor = null; message = '';
          if (showAudit) await loadAudit(); else render();
        }, { class: 'db-link' })));
    }
    if (message) content.push(h('p', { class: 'db-notice', role: 'status' }, message));
    if (busy) content.push(h('p', { class: 'db-note', role: 'status' }, tx('กำลังโหลด…')));
    else if (!databases.length) content.push(small(tx('ไม่พบฐานข้อมูล')));
    else if (showAudit) content.push(auditView());
    else if (showSQL) content.push(sqlView());
    else if (table) content.push(rowsView());
    else content.push(tablesView());
    body.replaceChildren(...content);
  }

  function tablesView() {
    return h('section', { class: 'db-section' },
      h('h2', { class: 'group-title' }, tx('ตาราง')),
      tables.length ? h('div', { class: 'list' }, tables.map((t) => h('button', { type: 'button', class: 'row', onclick: async () => {
        table = t; offset = 0; sort = ''; direction = 'asc'; search = ''; page = null; editor = null; message = '';
        await loadRows();
      } }, h('span', { class: 'row-main' }, h('span', { class: 'row-title db-mono' }, `${t.schema}.${t.name}`),
      h('span', { class: 'row-sub' }, tx('ประมาณ {0} แถว · {1}', Number(t.rows || 0).toLocaleString(), fmtBytes(Number(t.size))))),
      h('span', { class: 'db-chevron', 'aria-hidden': 'true' }, '›')))) : small(tx('ไม่พบตาราง')));
  }

  function auditView() {
    return h('section', { class: 'db-section' }, h('h2', { class: 'group-title' }, tx('ประวัติการแก้ไข')),
      audit.length ? h('div', { class: 'list' }, audit.map((item) => h('div', { class: 'row' },
        h('span', { class: 'row-main' }, h('span', { class: 'row-title db-mono' }, `${item.database} / ${item.schema}.${item.table}`),
          h('span', { class: 'row-sub db-audit-info' }, `${item.action} · ${item.status}${item.columns?.length ? ` · ${item.columns.join(', ')}` : ''}`)),
        h('span', { class: 'row-side' }, item.time ? new Date(item.time).toLocaleString() : '–')))) : small(tx('ยังไม่มีประวัติการแก้ไข')));
  }

  function sqlView() {
    const query = h('textarea', { class: 'field db-sql-input db-mono', rows: '5', 'aria-label': tx('คำสั่ง SQL'), placeholder: 'SELECT * FROM public.entries LIMIT 50' }, sql);
    query.addEventListener('input', () => { sql = query.value; });
    const write = h('input', { type: 'checkbox' });
    const form = h('form', { class: 'db-editor', onsubmit: async (event) => {
      event.preventDefault();
      sql = query.value;
      if (!sql.trim()) return;
      const writing = write.checked;
      if (writing && !window.confirm(tx('ยืนยันรันคำสั่งที่แก้ไขข้อมูลใน {0}?', database))) return;
      write.checked = false;
      const requestId = ++sequence;
      busy = true; message = ''; render();
      try {
        const result = await request('/sql', { method: 'POST', body: { database, sql, write: writing, confirm: writing } });
        if (!current() || requestId !== sequence || !showSQL) return;
        sqlResult = result.columns ? result : null;
        message = result.columns ? '' : tx('รันคำสั่งแล้ว');
        busy = false; render();
      } catch (err) { if (requestId === sequence) { busy = false; render(); fail(err); } }
    } },
      h('h2', { class: 'db-table-title' }, tx('คำสั่ง SQL')),
      small(tx('รองรับคำสั่งตารางเดียวและคอลัมน์ที่อนุญาตเท่านั้น คำสั่งอ่านเป็นค่าเริ่มต้น')),
      h('details', { class: 'db-sql-help' }, h('summary', {}, tx('รูปแบบคำสั่งที่รองรับ')),
        h('p', {}, tx('SELECT รองรับ ORDER BY และ LIMIT ส่วน UPDATE และ DELETE ต้องระบุคีย์หลักครบทุกช่อง')),
        h('pre', {}, 'SELECT * FROM public.entries ORDER BY name LIMIT 50\nINSERT INTO public.entries (name) VALUES (\'Example\')\nUPDATE public.entries SET name=\'Example\' WHERE id=\'…\'\nDELETE FROM public.entries WHERE id=\'…\''),
        h('p', {}, tx('ตัวอย่างแสดงรูปแบบเท่านั้น ต้องระบุค่าที่ตารางกำหนดให้ครบ'))),
      h('label', { class: 'db-field' }, h('span', {}, tx('คำสั่ง')), query),
      h('label', { class: 'db-sql-write' }, write, tx('อนุญาตให้แก้ไขข้อมูลสำหรับคำสั่งนี้')),
      h('button', { type: 'submit', class: 'btn primary' }, tx('รันคำสั่ง')));
    if (!sqlResult) return form;
    const cols = sqlResult.columns || [];
    if (cols.length && cols.every((col) => col.secret)) {
      return h('section', { class: 'db-section' }, form, h('h3', { class: 'group-title' }, tx('ผลลัพธ์ SQL')),
        small(tx('ข้อมูลทั้งหมดในตารางนี้ถูกซ่อนเพื่อความปลอดภัย')));
    }
    const data = sqlResult.rows || [];
    const header = h('tr', {}, cols.map((c) => h('th', { scope: 'col' }, c.name)));
    const records = data.map((row) => h('tr', {}, cols.map((c) => h('td', {}, c.secret
      ? h('span', { class: 'db-hidden' }, tx('ซ่อนข้อมูล'))
      : h('span', { class: 'db-value' }, valueText(row.values?.[c.name]))))));
    const result = data.length ? h('div', { class: 'db-table-wrap', tabindex: '0', 'aria-label': tx('ผลลัพธ์ SQL') },
      h('table', { class: 'db-table' }, h('thead', {}, header), h('tbody', {}, records))) : small(tx('ไม่พบข้อมูล'));
    return h('section', { class: 'db-section' }, form, h('h3', { class: 'group-title' }, tx('ผลลัพธ์ SQL')), small(tx('{0} แถว', data.length)), result);
  }

  function rowsView() {
    const heading = h('div', { class: 'db-table-heading' },
      button(tx('ตารางทั้งหมด'), () => { ++sequence; busy = false; table = null; page = null; editor = null; message = ''; render(); }, { class: 'db-link' }),
      h('h2', { class: 'db-table-title db-mono' }, `${table.schema}.${table.name}`));
    if (!page) return h('section', { class: 'db-section' }, heading);
    const cols = page.columns || [];
    if (cols.length && cols.every((col) => col.secret)) {
      return h('section', { class: 'db-section' }, heading,
        small(tx('ข้อมูลทั้งหมดในตารางนี้ถูกซ่อนเพื่อความปลอดภัย')));
    }
    const input = h('input', { class: 'field', type: 'search', value: search, placeholder: tx('ค้นหาในตาราง'), 'aria-label': tx('ค้นหาในตาราง') });
    const searchForm = h('form', { class: 'db-search', onsubmit: async (event) => {
      event.preventDefault(); search = input.value; offset = 0; editor = null; await loadRows();
    } }, input, h('button', { class: 'btn', type: 'submit' }, tx('ค้นหา')));
    const editInfo = page.editable === false ? small(tx('ตารางนี้ไม่มีคีย์ที่ใช้แก้ไขแถวได้ จึงดูข้อมูลได้อย่างเดียว')) : null;
    const rows = page.rows || [];
    const canWrite = page.editable !== false;
    const header = h('tr', {}, cols.map((col) => h('th', { scope: 'col', 'aria-sort': sort === col.name ? (direction === 'asc' ? 'ascending' : 'descending') : undefined }, col.secret ? col.name : h('button', {
      type: 'button', class: 'db-sort', 'aria-label': tx('เรียงตาม {0}', col.name), onclick: async () => {
        if (sort === col.name) direction = direction === 'asc' ? 'desc' : 'asc';
        else { sort = col.name; direction = 'asc'; }
        offset = 0; editor = null; await loadRows();
      },
    }, col.name, sort === col.name ? (direction === 'asc' ? ' ↑' : ' ↓') : ''))), h('th', { scope: 'col' }, tx('จัดการ')));
    const dataRows = rows.map((row) => h('tr', {}, cols.map((col) => h('td', {},
      col.secret ? h('span', { class: 'db-hidden' }, tx('ซ่อนข้อมูล')) : h('span', { class: 'db-value', title: valueText(row.values?.[col.name]) }, valueText(row.values?.[col.name])))),
      h('td', { class: 'db-row-actions' },
        button(tx('แก้ไข'), () => { editor = { row }; message = ''; render(); document.getElementById('db-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, { disabled: !canWrite || !row.key || !Object.keys(row.key).length }),
        button(tx('ลบ'), async () => {
          if (!window.confirm(tx('ยืนยันลบแถวจาก {0}?', identity()))) return;
          try {
            await request('/rows', { method: 'POST', body: { database, schema: table.schema, table: table.name, action: 'delete', key: row.key, version: row.version, confirm: true } });
            message = tx('ลบแถวแล้ว'); await loadRows();
          } catch (err) { fail(err); }
        }, { class: 'btn danger', disabled: !canWrite || !row.key || !Object.keys(row.key).length }))));
    const total = Number(page.total || 0);
    const from = total ? offset + 1 : 0;
    const to = Math.min(offset + rows.length, total);
    const pages = h('div', { class: 'db-pages' },
      button(tx('ก่อนหน้า'), async () => { offset = Math.max(0, offset - limit); editor = null; await loadRows(); }, { disabled: offset === 0 }),
      h('span', { role: 'status' }, tx('{0}–{1} จาก {2}', from, to, total)),
      button(tx('ถัดไป'), async () => { offset += limit; editor = null; await loadRows(); }, { disabled: offset + rows.length >= total || rows.length === 0 }));
    return h('section', { class: 'db-section' }, heading, searchForm,
      h('div', { class: 'db-toolbar' }, h('span', { class: 'db-count' }, tx('{0} แถว', total)),
        button(tx('เพิ่มแถว'), () => { editor = { row: null }; message = ''; render(); document.getElementById('db-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, { class: 'btn primary', disabled: !cols.some((col) => !col.secret && !col.generated) })),
      editInfo, editor ? editorView(cols) : null,
      rows.length ? h('div', { class: 'db-table-wrap', tabindex: '0', 'aria-label': tx('ข้อมูลในตาราง') },
        h('table', { class: 'db-table' }, h('thead', {}, header), h('tbody', {}, dataRows))) : small(tx('ไม่พบข้อมูล')),
      pages);
  }

  function editorView(cols) {
    const inserting = !editor.row;
    const row = editor.row;
    const controls = [];
    const form = h('form', { id: 'db-editor', class: 'db-editor', onsubmit: async (event) => {
      event.preventDefault();
      const values = {};
      for (const control of controls) {
        if (control.mode.value === 'value') values[control.name] = control.input.value;
        else if (control.mode.value === 'null') values[control.name] = null;
      }
      if (!inserting && !Object.keys(values).length) { message = tx('เลือกอย่างน้อยหนึ่งช่องที่ต้องการแก้ไข'); render(); return; }
      if (!window.confirm(inserting ? tx('ยืนยันเพิ่มแถวใน {0}?', identity()) : tx('ยืนยันแก้ไขแถวใน {0}?', identity()))) return;
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        await request('/rows', { method: 'POST', body: { database, schema: table.schema, table: table.name,
          action: inserting ? 'insert' : 'update', key: row?.key || {}, version: row?.version, values, confirm: true } });
        editor = null; message = inserting ? tx('เพิ่มแถวแล้ว') : tx('แก้ไขแถวแล้ว'); await loadRows();
      } catch (err) { submit.disabled = false; fail(err); }
    } }, h('h3', {}, inserting ? tx('เพิ่มแถว') : tx('แก้ไขแถว')),
    small(tx('การแก้ไขตรงจะข้ามการตรวจสอบของแอป ควรสำรองข้อมูลก่อน')),
    cols.filter((col) => !col.secret && !col.generated && (inserting || !col.primary)).map((col) => {
      const mode = h('select', { class: 'field db-mode', 'aria-label': tx('วิธีใส่ค่า {0}', col.name) },
        h('option', { value: 'keep' }, inserting ? tx('ไม่ระบุ') : tx('ไม่เปลี่ยน')),
        h('option', { value: 'value' }, tx('ระบุค่า')),
        col.nullable ? h('option', { value: 'null' }, 'NULL') : null);
      const input = h('textarea', { class: 'field db-input', rows: '2', 'aria-label': col.name, disabled: true }, inserting ? '' : valueText(row.values?.[col.name]));
      mode.addEventListener('change', () => { input.disabled = mode.value !== 'value'; if (!input.disabled) input.focus(); });
      controls.push({ name: col.name, mode, input });
      return h('div', { class: 'db-edit-field' }, h('label', {}, h('strong', { class: 'db-mono' }, col.name), h('span', { class: 'db-type' }, col.type)), mode, input);
    }),
    h('div', { class: 'db-edit-actions' }, button(tx('ยกเลิก'), () => { editor = null; render(); }), h('button', { type: 'submit', class: 'btn primary' }, tx('บันทึก'))));
    return form;
  }

  async function loadTables() {
    const requestId = ++sequence;
    busy = true; render();
    try {
      const data = await request(`/tables?${params({ database })}`);
      if (!current() || requestId !== sequence) return;
      tables = data.tables || []; busy = false; render();
    } catch (err) { if (requestId === sequence) { busy = false; render(); fail(err); } }
  }
  async function loadRows() {
    const requestId = ++sequence;
    busy = true; render();
    try {
      const data = await request(`/rows?${params({ database, schema: table.schema, table: table.name, limit, offset, sort, direction, search })}`);
      if (!current() || requestId !== sequence) return;
      page = data; busy = false; render();
    } catch (err) { if (requestId === sequence) { busy = false; render(); fail(err); } }
  }
  async function loadAudit() {
    const requestId = ++sequence;
    busy = true; render();
    try {
      const data = await request('/audit');
      if (!current() || requestId !== sequence || !showAudit) return;
      audit = data.entries || []; busy = false; render();
    } catch (err) { if (requestId === sequence) { busy = false; render(); fail(err); } }
  }
  async function refresh() {
    if (showAudit) return loadAudit();
    if (showSQL) { render(); return; }
    if (table) return loadRows();
    if (database) return loadTables();
    const requestId = ++sequence;
    busy = true; render();
    try {
      const result = await request('/databases');
      if (!current() || requestId !== sequence) return;
      databases = result.databases || []; database = databases[0]?.name || ''; busy = false;
      if (database) await loadTables(); else render();
    } catch (err) { if (requestId === sequence) { busy = false; render(); fail(err); } }
  }
  await refresh();
}
