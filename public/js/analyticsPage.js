document.addEventListener('DOMContentLoaded', () => {
    const page = document.getElementById('analyticsPage');
    if (!page) return;

    const $ = (id) => document.getElementById(id);
    const rangeSelect = $('rangeSelect');
    const refreshBtn = $('refreshBtn');
    const movingAvgToggle = $('messagesMovingAvgToggle');

    const green = '#22c55e';
    const red = '#ef4444';
    const amber = '#f59e0b';
    const grey = '#9ca3af';

    const charts = {};
    let data = {};            // последние загруженные данные (для перерисовки и CSV)
    let topMode = 'messages'; // переключатель «Топ-5» на обзоре
    let loading = false;
    let firstRender = true;

    // Акцентный цвет сайта (HEX) и "r, g, b" для полупрозрачных заливок
    function accentHex() {
        const v = (getComputedStyle(document.documentElement).getPropertyValue('--accent-color') || '').trim();
        return /^#[0-9a-f]{6}$/i.test(v) ? v : '#8b5cf6';
    }
    function accentRgb() {
        const n = parseInt(accentHex().slice(1), 16);
        return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
    }

    function getRange() {
        return parseInt(rangeSelect.value, 10) || 7;
    }

    function formatDay(dayStr) {
        const parts = String(dayStr).split('-');
        return parts.length === 3 ? `${parts[2]}.${parts[1]}` : dayStr;
    }

    function fmtNum(n) {
        return Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
    }

    async function fetchJson(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Ошибка запроса: ${url}`);
        return res.json();
    }

    // Один упавший запрос не должен ломать всю страницу
    async function safe(url, fallback) {
        try {
            return await fetchJson(url);
        } catch (err) {
            console.error(err);
            return fallback;
        }
    }

    function normSeries(rows) {
        rows = Array.isArray(rows) ? rows : [];
        return {
            days: rows.map(r => r.day),
            labels: rows.map(r => formatDay(r.day)),
            values: rows.map(r => parseFloat(r.value) || 0)
        };
    }

    function movingAverage(values, windowSize = 3) {
        return values.map((_, i) => {
            const slice = values.slice(Math.max(0, i - windowSize + 1), i + 1);
            return Math.round((slice.reduce((a, b) => a + b, 0) / slice.length) * 100) / 100;
        });
    }

    function destroyChart(key) {
        if (charts[key]) {
            charts[key].destroy();
            delete charts[key];
        }
    }

    // Заглушка «данных пока нет» поверх графика
    function setEmpty(canvasId, isEmpty) {
        const canvas = $(canvasId);
        const wrap = canvas && canvas.parentElement;
        if (!wrap) return;
        let note = wrap.querySelector('.st-empty');
        if (isEmpty && !note) {
            note = document.createElement('div');
            note.className = 'st-empty';
            note.textContent = 'Данных за этот период пока нет';
            wrap.appendChild(note);
        } else if (!isEmpty && note) {
            note.remove();
        }
    }

    function baseOptions(animate, showLegend) {
        return {
            responsive: true,
            animation: animate ? { duration: 500 } : false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { display: !!showLegend, labels: { color: '#d1d5db' } } },
            scales: {
                x: { ticks: { color: grey, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { ticks: { color: grey, precision: 0 }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true }
            }
        };
    }

    function drawChart(id, type, labels, datasets, animate, showLegend) {
        destroyChart(id);
        const ctx = $(id);
        if (!ctx) return;
        charts[id] = new Chart(ctx, { type, data: { labels, datasets }, options: baseOptions(animate, showLegend) });
    }

    function barSet(label, values, color) {
        return { label, data: values, backgroundColor: color, borderRadius: 4, maxBarThickness: 28 };
    }

    function lineSet(label, values, color, fill = true) {
        return {
            label, data: values, borderColor: color, backgroundColor: color + '26',
            fill, tension: 0.35, pointRadius: 2, borderWidth: 2
        };
    }

    // Мини-график в карточке (без осей и подсказок)
    function drawSpark(id, values, color) {
        destroyChart(id);
        const ctx = $(id);
        if (!ctx) return;
        charts[id] = new Chart(ctx, {
            type: 'line',
            data: { labels: values.map((_, i) => i), datasets: [{ data: values, borderColor: color, backgroundColor: color + '26', fill: true, tension: 0.35, pointRadius: 0, borderWidth: 2 }] },
            options: {
                responsive: true, maintainAspectRatio: false, animation: false,
                plugins: { legend: { display: false }, tooltip: { enabled: false } },
                scales: { x: { display: false }, y: { display: false, beginAtZero: true } }
            }
        });
    }

    function setTrend(id, value) {
        const el = $(id);
        if (!el) return;
        if (value > 0) { el.textContent = `▲ ${value}%`; el.className = 'st-trend up'; }
        else if (value < 0) { el.textContent = `▼ ${Math.abs(value)}%`; el.className = 'st-trend down'; }
        else { el.textContent = '0%'; el.className = 'st-trend'; }
    }

    // Список топа: место, аватарка (или буква), имя, полоска, значение
    function renderTopList(containerId, items, unitLabel) {
        const container = $(containerId);
        if (!container) return;
        if (!items.length) {
            container.innerHTML = '<span class="st-muted small">Данных за этот период пока нет</span>';
            return;
        }
        const max = Math.max(...items.map(i => i.value)) || 1;
        container.innerHTML = items.map((item, idx) => {
            const label = String(item.label || '—');
            const ava = item.avatar
                ? `<img src="${escapeHtml(item.avatar)}" class="st-ava" alt="">`
                : `<div class="st-ava text-white">${escapeHtml(label.replace(/^#/, '').charAt(0).toUpperCase())}</div>`;
            return `
                <div class="st-top-row">
                    <span class="st-rank">${idx + 1}</span>
                    ${ava}
                    <span class="st-name" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
                    <div class="st-track"><div class="st-fill" style="width:${Math.max(4, (item.value / max) * 100)}%;"></div></div>
                    <span class="st-num">${fmtNum(item.value)} ${unitLabel}</span>
                </div>`;
        }).join('');
    }

    function exportCSV(filename, rows, headers) {
        const lines = [headers.join(',')];
        rows.forEach(row => lines.push(row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')));
        const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ---------- Отрисовка блоков ----------

    function renderCards() {
        const o = data.overview || {};
        const t = o.trends || {};
        $('statTotalMembers').textContent = o.totalMembers ?? '—';
        $('statMessages').textContent = fmtNum(o.totalMessages ?? 0);
        $('statVoice').textContent = fmtNum(o.totalVoiceHours ?? 0);
        $('statActive').textContent = fmtNum(o.activeMembers ?? 0);
        $('statJoins').textContent = `+${o.joins ?? 0}`;
        $('statLeaves').textContent = `-${o.leaves ?? 0}`;

        const net = (o.joins ?? 0) - (o.leaves ?? 0);
        $('statNet').textContent = `${net > 0 ? '+' : ''}${net} за период`;

        setTrend('trendMessages', t.messages || 0);
        setTrend('trendVoice', t.voiceHours || 0);
        setTrend('trendActive', t.active || 0);

        drawSpark('sparkMessages', data.messages.values, accentHex());
        drawSpark('sparkVoice', data.voice.values, green);

        // Статистика матов
        const sw = data.swears || {};
        $('statSwears').textContent = fmtNum(sw.total || 0);
        setTrend('trendSwears', sw.trend || 0);
        if (sw.dailySeries && sw.dailySeries.length > 0) {
            drawSpark('sparkSwears', sw.dailySeries.map(d => d.value), red);
        }

        // Пик активности и самый активный канал
        const peak = findPeak(data.heat);
        $('statPeak').textContent = peak ? peak.text : '—';
        const topCh = (data.topChannelsMessages || [])[0];
        $('statTopChannel').textContent = topCh ? `Топ канал: #${topCh.name}` : 'Топ канал: нет данных';
    }

    const DOW_NAMES = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

    function findPeak(rows) {
        if (!Array.isArray(rows) || !rows.length) return null;
        let best = null;
        rows.forEach(r => { if (!best || r.value > best.value) best = r; });
        if (!best || best.value <= 0) return null;
        return { text: `${DOW_NAMES[best.weekday]}, ${String(best.hour).padStart(2, '0')}:00`, value: best.value };
    }

    function summarize(series, chipTotal, chipAvg, chipBest) {
        const total = series.values.reduce((a, b) => a + b, 0);
        const count = series.values.length || 1;
        $(chipTotal).textContent = fmtNum(total);
        $(chipAvg).textContent = fmtNum(total / count);
        let bestIdx = -1;
        series.values.forEach((v, i) => { if (v > 0 && (bestIdx < 0 || v > series.values[bestIdx])) bestIdx = i; });
        $(chipBest).textContent = bestIdx >= 0 ? `${series.labels[bestIdx]} (${fmtNum(series.values[bestIdx])})` : '—';
    }

    function renderMessagesTab(animate) {
        const s = data.messages;
        const datasets = [lineSet('Сообщения', s.values, accentHex())];
        if (movingAvgToggle && movingAvgToggle.checked) {
            datasets.push({ label: 'Скользящее среднее', data: movingAverage(s.values, 3), borderColor: amber, borderDash: [6, 4], fill: false, pointRadius: 0, tension: 0.35, borderWidth: 2 });
        }
        drawChart('chartMessages', 'line', s.labels, datasets, animate, true);
        setEmpty('chartMessages', s.values.every(v => v === 0));
    }

    function renderCharts(animate) {
        const { messages, voice, joins, leaves } = data;
        const accent = accentHex();

        // Обзор: столбцы
        drawChart('chartOverviewMessages', 'bar', messages.labels, [barSet('Сообщения', messages.values, accent)], animate, false);
        setEmpty('chartOverviewMessages', messages.values.every(v => v === 0));
        drawChart('chartOverviewVoice', 'bar', voice.labels, [barSet('Часы в войсе', voice.values, green)], animate, false);
        setEmpty('chartOverviewVoice', voice.values.every(v => v === 0));

        // Приход/уход: парный график (уход вниз)
        const leavesMap = Object.fromEntries(leaves.days.map((d, i) => [d, leaves.values[i]]));
        const joinsMap = Object.fromEntries(joins.days.map((d, i) => [d, joins.values[i]]));
        const days = [...new Set([...joins.days, ...leaves.days])].sort();
        const labels = days.map(formatDay);
        const joinsData = days.map(d => joinsMap[d] || 0);
        const leavesData = days.map(d => leavesMap[d] || 0);
        data.membersTable = { labels, joinsData, leavesData };

        drawChart('chartOverviewMembers', 'bar', labels, [barSet('Пришло', joinsData, green), barSet('Ушло', leavesData.map(v => -v), red)], animate, true);
        setEmpty('chartOverviewMembers', joinsData.every(v => v === 0) && leavesData.every(v => v === 0));

        // Вкладки «Сообщения» и «Войс»
        renderMessagesTab(animate);
        summarize(messages, 'msgTotal', 'msgAvg', 'msgBest');
        drawChart('chartVoice', 'line', voice.labels, [lineSet('Часы в войсе', voice.values, green)], animate, false);
        setEmpty('chartVoice', voice.values.every(v => v === 0));
        summarize(voice, 'voiceTotal', 'voiceAvg', 'voiceBest');

        // Вкладка «Участники»: накопленный прирост
        let acc = 0;
        const netValues = days.map((_, i) => (acc += joinsData[i] - leavesData[i]));
        const netOptionsChart = lineSet('Прирост', netValues, accent);
        drawChart('chartNet', 'line', labels, [netOptionsChart], animate, false);
        if (charts.chartNet) { charts.chartNet.options.scales.y.beginAtZero = false; charts.chartNet.update('none'); }
        setEmpty('chartNet', joinsData.every(v => v === 0) && leavesData.every(v => v === 0));

        // Статусы: прореживаем до ~150 точек
        const st = Array.isArray(data.status) ? data.status : [];
        const step = Math.max(1, Math.ceil(st.length / 150));
        const pts = st.filter((_, i) => i % step === 0);
        const sl = pts.map(p => `${p.point.slice(8, 10)}.${p.point.slice(5, 7)} ${p.point.slice(11)}`);
        drawChart('chartStatus', 'line', sl, [
            { ...lineSet('В сети', pts.map(p => Number(p.online_count) || 0), green, false), pointRadius: 0 },
            { ...lineSet('Неактивен', pts.map(p => Number(p.idle_count) || 0), amber, false), pointRadius: 0 },
            { ...lineSet('Не беспокоить', pts.map(p => Number(p.dnd_count) || 0), red, false), pointRadius: 0 }
        ], animate, true);
        setEmpty('chartStatus', pts.length === 0);
    }

    function renderOverviewTop() {
        const isVoice = topMode === 'voice';
        const src = (isVoice ? data.topMembersVoice : data.topMembersMessages) || [];
        renderTopList('topOverview', src.slice(0, 5).map(m => ({ label: m.username, value: parseFloat(m.value) || 0, avatar: m.avatar })), isVoice ? 'ч.' : 'сообщ.');
    }

    function renderTops() {
        const map = (arr, prefix) => (arr || []).map(x => ({ label: prefix ? prefix + x.name : x.username, value: parseFloat(x.value) || 0, avatar: x.avatar }));
        renderTopList('topMembersMessages', map(data.topMembersMessages), 'сообщ.');
        renderTopList('topChannelsMessages', map(data.topChannelsMessages, '#'), 'сообщ.');
        renderTopList('topMembersVoice', map(data.topMembersVoice), 'ч.');
        renderTopList('topChannelsVoice', map(data.topChannelsVoice, '#'), 'ч.');
        renderOverviewTop();

        // Топ матерящихся
        const topSwearers = (data.swears && data.swears.topSwearers) || [];
        renderTopList('topSwearers', topSwearers.map(s => ({ label: s.username, value: s.count, avatar: s.avatar })), 'матов');
    }

    function renderHeatmap() {
        const rows = Array.isArray(data.heat) ? data.heat : [];
        const container = $('heatmapContainer');
        if (!container) return;
        const grid = {};
        let maxValue = 0;
        rows.forEach(r => {
            grid[`${r.weekday}-${r.hour}`] = r.value;
            if (r.value > maxValue) maxValue = r.value;
        });
        if (maxValue === 0) {
            container.innerHTML = '<span class="st-muted small">Данных за этот период пока нет</span>';
            return;
        }

        const weekdayOrder = [1, 2, 3, 4, 5, 6, 0];
        const rgb = accentRgb();

        let html = `<div class="st-heat-grid"><div></div>`;
        for (let h = 0; h < 24; h++) html += `<div class="st-heat-hour">${h}</div>`;
        html += `</div>`;

        weekdayOrder.forEach(dow => {
            html += `<div class="st-heat-grid"><div class="st-heat-label">${DOW_NAMES[dow]}</div>`;
            for (let h = 0; h < 24; h++) {
                const value = grid[`${dow}-${h}`] || 0;
                const bg = value === 0 ? 'rgba(255,255,255,0.04)' : `rgba(${rgb}, ${0.15 + (value / maxValue) * 0.8})`;
                html += `<div class="st-heat-cell" title="${DOW_NAMES[dow]} ${h}:00 — ${value} сообщ." style="background:${bg};"></div>`;
            }
            html += `</div>`;
        });
        container.innerHTML = html;
    }

    function renderSwearsTab(animate) {
        const sw = data.swears || {};
        const series = normSeries(sw.dailySeries || []);
        
        drawChart('chartSwears', 'line', series.labels, [lineSet('Маты', series.values, red)], animate, false);
        setEmpty('chartSwears', series.values.every(v => v === 0));
        
        summarize(series, 'swearTotal', 'swearAvg', 'swearBest');
    }

    // ---------- Загрузка ----------

    async function loadAll(silent) {
        if (loading) return;
        loading = true;
        if (!silent) page.classList.add('st-loading');
        const d = getRange();
        const heatDays = Math.max(d, 7);
        try {
            const [overview, msgs, voice, joins, leaves, status, tmm, tmc, tvm, tvc, heat, swears] = await Promise.all([
                safe(`/api/analytics/overview?days=${d}`, {}),
                safe(`/api/analytics/series?days=${d}&type=messages`, []),
                safe(`/api/analytics/series?days=${d}&type=voice`, []),
                safe(`/api/analytics/series?days=${d}&type=joins`, []),
                safe(`/api/analytics/series?days=${d}&type=leaves`, []),
                safe(`/api/analytics/status?days=${d}`, []),
                safe(`/api/analytics/top-members?days=${d}&metric=messages`, []),
                safe(`/api/analytics/top-channels?days=${d}&metric=messages`, []),
                safe(`/api/analytics/top-members?days=${d}&metric=voice`, []),
                safe(`/api/analytics/top-channels?days=${d}&metric=voice`, []),
                safe(`/api/analytics/heatmap?days=${heatDays}`, []),
                safe(`/api/swear-words/stats?days=${d}`, {})
            ]);

            // Обогащаем топ матерящихся данными пользователей
            const enrichedSwearers = await Promise.all((swears.topSwearers || []).map(async (s) => {
                try {
                    const user = await safe(`/api/discord/users/${s.user_id}`, null);
                    return {
                        ...s,
                        username: user ? user.username : s.user_id,
                        avatar: user ? user.avatar : 'https://cdn.discordapp.com/embed/avatars/0.png'
                    };
                } catch (e) {
                    return {
                        ...s,
                        username: s.user_id,
                        avatar: 'https://cdn.discordapp.com/embed/avatars/0.png'
                    };
                }
            }));

            data = {
                overview,
                messages: normSeries(msgs),
                voice: normSeries(voice),
                joins: normSeries(joins),
                leaves: normSeries(leaves),
                status,
                topMembersMessages: tmm, topChannelsMessages: tmc,
                topMembersVoice: tvm, topChannelsVoice: tvc,
                heat,
                swears: { ...swears, topSwearers: enrichedSwearers }
            };

            const animate = !silent || firstRender;
            renderCards();
            renderCharts(animate);
            renderTops();
            renderHeatmap();
            renderSwearsTab(animate);
            firstRender = false;

            const now = new Date();
            $('lastUpdated').textContent = `Обновлено в ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        } catch (err) {
            console.error('Ошибка загрузки статистики:', err);
        } finally {
            page.classList.remove('st-loading');
            loading = false;
        }
    }

    // ---------- События ----------

    refreshBtn.addEventListener('click', () => loadAll(false));
    rangeSelect.addEventListener('change', () => loadAll(false));

    if (movingAvgToggle) {
        movingAvgToggle.addEventListener('change', () => { if (data.messages) renderMessagesTab(false); });
    }

    document.querySelectorAll('[data-top-mode]').forEach(btn => {
        btn.addEventListener('click', () => {
            topMode = btn.getAttribute('data-top-mode');
            document.querySelectorAll('[data-top-mode]').forEach(b => b.classList.toggle('active', b === btn));
            if (data.topMembersMessages) renderOverviewTop();
        });
    });

    document.querySelectorAll('[data-export]').forEach(btn => {
        btn.addEventListener('click', () => {
            const type = btn.getAttribute('data-export');
            const days = getRange();

            if (type === 'members' && data.membersTable) {
                const m = data.membersTable;
                exportCSV(`members_${days}d.csv`, m.labels.map((l, i) => [l, m.joinsData[i], m.leavesData[i]]), ['Дата', 'Пришло', 'Ушло']);
                return;
            }
            if (type === 'swears' && data.swears && data.swears.dailySeries) {
                const series = normSeries(data.swears.dailySeries);
                exportCSV(`swears_${days}d.csv`, series.labels.map((l, i) => [l, series.values[i]]), ['Дата', 'Матов']);
                return;
            }
            const series = data[type];
            if (!series) return;
            exportCSV(`${type}_${days}d.csv`, series.labels.map((l, i) => [l, series.values[i]]), ['Дата', 'Значение']);
        });
    });

    // Автообновление раз в минуту, пока вкладка браузера открыта
    setInterval(() => { if (!document.hidden) loadAll(true); }, 60000);

    loadAll(false);
});