/**
 * Polymarket Backtester Dashboard
 */

const API_BASE = '/api';

// State
let equityChart = null;
let currentRunId = null;

// ============================================
// API Calls
// ============================================

async function fetchApi(endpoint) {
  try {
    const response = await fetch(`${API_BASE}${endpoint}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error(`API error (${endpoint}):`, error);
    return null;
  }
}

async function postApi(endpoint, data) {
  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error(`API error (${endpoint}):`, error);
    return null;
  }
}

// ============================================
// UI Updates
// ============================================

function updateStatus(connected) {
  const statusText = document.getElementById('status-text');
  const statusDot = document.querySelector('.status-dot');
  
  if (connected) {
    statusText.textContent = 'Connected';
    statusDot.style.background = 'var(--accent-green)';
  } else {
    statusText.textContent = 'Disconnected';
    statusDot.style.background = 'var(--accent-red)';
  }
}

function updateStats(stats) {
  document.getElementById('stat-markets').textContent = stats.marketCount.toLocaleString();
  document.getElementById('stat-prices').textContent = stats.pricePointCount.toLocaleString();
  document.getElementById('stat-runs').textContent = stats.backtestRunCount.toLocaleString();
  document.getElementById('stat-trades').textContent = stats.tradeCount.toLocaleString();
}

function updateConfig(config) {
  const container = document.getElementById('config-display');
  
  const items = [
    { key: 'Entry Min', value: config.strategy.entryPriceMin },
    { key: 'Entry Max', value: config.strategy.entryPriceMax },
    { key: 'Exit Target', value: config.strategy.exitPriceTarget },
    { key: 'Days Min', value: config.strategy.timeToResolutionDaysMin },
    { key: 'Days Max', value: config.strategy.timeToResolutionDaysMax },
    { key: 'Position Size', value: `$${config.risk.positionSizeUsd}` },
    { key: 'Max Positions', value: config.risk.maxPositions },
    { key: 'Max Exposure', value: `$${config.risk.maxExposureUsd}` },
  ];
  
  // Add classification settings
  if (config.classification) {
    const volatilityStatus = config.classification.volatility.enabled 
      ? `ON (${config.classification.volatility.highVolatilityThreshold}%)`
      : 'OFF';
    const llmStatus = config.classification.llmConvergence.enabled 
      ? `ON (${config.classification.llmConvergence.model})`
      : 'OFF';
    
    items.push(
      { key: 'Volatility Class.', value: volatilityStatus },
      { key: 'LLM Class.', value: llmStatus }
    );
  }
  
  container.innerHTML = items.map(item => `
    <div class="config-item">
      <span class="config-key">${item.key}</span>
      <span class="config-value">${item.value}</span>
    </div>
  `).join('');
}

function updateClassificationBreakdown(breakdown) {
  // Update volatility display
  const volContainer = document.getElementById('volatility-display');
  if (volContainer) {
    if (!breakdown?.byVolatility || breakdown.byVolatility.length === 0) {
      volContainer.innerHTML = `<div class="empty-state"><p>No volatility data</p></div>`;
    } else {
      volContainer.innerHTML = breakdown.byVolatility.map(item => {
        const pnlClass = item.totalPnL >= 0 ? 'positive' : 'negative';
        const pnlSign = item.totalPnL >= 0 ? '+' : '';
        const levelLabel = item.label.charAt(0).toUpperCase() + item.label.slice(1);
        
        return `
          <div class="config-item">
            <span class="config-key">${levelLabel}</span>
            <span class="config-value">
              ${item.tradeCount} trades, ${(item.winRate * 100).toFixed(0)}% win
              <span class="${pnlClass}">${pnlSign}$${item.totalPnL.toFixed(2)}</span>
            </span>
          </div>
        `;
      }).join('');
    }
  }
  
  // Update category display
  const catContainer = document.getElementById('category-display');
  if (catContainer) {
    if (!breakdown?.byCategory || breakdown.byCategory.length === 0) {
      catContainer.innerHTML = `<div class="empty-state"><p>No category data</p></div>`;
    } else {
      catContainer.innerHTML = breakdown.byCategory.slice(0, 8).map(item => {
        const pnlClass = item.totalPnL >= 0 ? 'positive' : 'negative';
        const pnlSign = item.totalPnL >= 0 ? '+' : '';
        
        return `
          <div class="config-item">
            <span class="config-key">${item.label}</span>
            <span class="config-value">
              ${item.tradeCount} trades, ${(item.winRate * 100).toFixed(0)}% win
              <span class="${pnlClass}">${pnlSign}$${item.totalPnL.toFixed(2)}</span>
            </span>
          </div>
        `;
      }).join('');
    }
  }
}

function updateCategoryPerformance(categories) {
  // Legacy function - redirect to new breakdown
  updateClassificationBreakdown({ byCategory: categories.map(c => ({ ...c, label: c.category })) });
}

function updateRuns(runs) {
  const container = document.getElementById('runs-list');
  
  if (runs.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>No backtest runs yet</p>
      </div>
    `;
    return;
  }
  
  container.innerHTML = runs.slice(0, 5).map(run => {
    const pnlClass = run.total_pnl >= 0 ? 'positive' : 'negative';
    const pnlSign = run.total_pnl >= 0 ? '+' : '';
    
    return `
      <div class="run-item" data-run-id="${run.id}" onclick="selectRun('${run.id}')">
        <div>
          <div class="run-id">${run.id}</div>
          <div style="font-size: 0.75rem; color: var(--text-muted);">
            ${run.total_trades || 0} trades
          </div>
        </div>
        <div class="run-pnl ${pnlClass}">
          ${pnlSign}$${(run.total_pnl || 0).toFixed(2)}
        </div>
      </div>
    `;
  }).join('');
}

function updateTrades(trades) {
  const tbody = document.getElementById('trades-body');
  
  if (trades.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-state">
          <p>No trades to display</p>
        </td>
      </tr>
    `;
    return;
  }
  
  tbody.innerHTML = trades.slice(0, 20).map(trade => {
    const pnlClass = trade.pnl >= 0 ? 'positive' : 'negative';
    const pnlSign = trade.pnl >= 0 ? '+' : '';
    const marketShort = trade.market_id.substring(0, 16) + '...';
    
    return `
      <tr>
        <td class="mono" title="${trade.market_id}">${marketShort}</td>
        <td><span style="color: ${trade.side === 'YES' ? 'var(--accent-green)' : 'var(--accent-red)'}">${trade.side}</span></td>
        <td class="mono">${trade.entry_price.toFixed(3)}</td>
        <td class="mono">${trade.exit_price ? trade.exit_price.toFixed(3) : '-'}</td>
        <td class="mono ${pnlClass}">${pnlSign}$${(trade.pnl || 0).toFixed(2)}</td>
        <td>${trade.exit_reason || '-'}</td>
      </tr>
    `;
  }).join('');
}

function updatePerformance(run) {
  const container = document.getElementById('performance-display');
  
  if (!run) {
    container.innerHTML = `
      <div class="empty-state">
        <p>Select a run to see metrics</p>
      </div>
    `;
    return;
  }
  
  const winRate = run.total_trades > 0 
    ? ((run.winning_trades / run.total_trades) * 100).toFixed(1) 
    : 0;
  
  const items = [
    { key: 'Total PnL', value: `$${(run.total_pnl || 0).toFixed(2)}`, positive: run.total_pnl >= 0 },
    { key: 'Win Rate', value: `${winRate}%` },
    { key: 'Total Trades', value: run.total_trades || 0 },
    { key: 'Winning', value: run.winning_trades || 0 },
    { key: 'Max Drawdown', value: `$${(run.max_drawdown || 0).toFixed(2)}` },
    { key: 'Sharpe Ratio', value: (run.sharpe_ratio || 0).toFixed(2) },
  ];
  
  container.innerHTML = items.map(item => `
    <div class="config-item">
      <span class="config-key">${item.key}</span>
      <span class="config-value" ${item.positive !== undefined ? `style="color: ${item.positive ? 'var(--accent-green)' : 'var(--accent-red)'}"` : ''}>
        ${item.value}
      </span>
    </div>
  `).join('');
}

// ============================================
// Charts
// ============================================

function initEquityChart() {
  const ctx = document.getElementById('equity-chart').getContext('2d');
  
  equityChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Equity',
        data: [],
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        pointHoverRadius: 4,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: '#1a2332',
          titleColor: '#e2e8f0',
          bodyColor: '#94a3b8',
          borderColor: '#334155',
          borderWidth: 1,
          padding: 12,
          callbacks: {
            label: function(context) {
              return `$${context.parsed.y.toFixed(2)}`;
            }
          }
        }
      },
      scales: {
        x: {
          display: true,
          grid: {
            color: 'rgba(51, 65, 85, 0.3)',
          },
          ticks: {
            color: '#64748b',
            maxTicksLimit: 8,
          }
        },
        y: {
          display: true,
          grid: {
            color: 'rgba(51, 65, 85, 0.3)',
          },
          ticks: {
            color: '#64748b',
            callback: function(value) {
              return '$' + value;
            }
          }
        }
      },
      interaction: {
        mode: 'nearest',
        axis: 'x',
        intersect: false,
      },
    }
  });
}

function updateEquityChart(equityCurve) {
  if (!equityChart || !equityCurve || equityCurve.length === 0) return;
  
  const labels = equityCurve.map(p => {
    const date = new Date(p.timestamp);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });
  
  const data = equityCurve.map(p => p.equity);
  
  equityChart.data.labels = labels;
  equityChart.data.datasets[0].data = data;
  equityChart.update();
}

// ============================================
// Actions
// ============================================

async function selectRun(runId) {
  currentRunId = runId;
  
  // Fetch run details
  const run = await fetchApi(`/backtests/${runId}`);
  if (run) {
    updatePerformance(run);
  }
  
  // Fetch trades
  const trades = await fetchApi(`/backtests/${runId}/trades`);
  if (trades) {
    updateTrades(trades);
  }
  
  // Fetch equity curve
  const equity = await fetchApi(`/backtests/${runId}/equity`);
  if (equity) {
    updateEquityChart(equity);
  }
  
  // Fetch full classification breakdown
  const breakdown = await fetchApi(`/backtests/${runId}/breakdown`);
  if (breakdown) {
    updateClassificationBreakdown(breakdown);
  }
  
  // Highlight selected run
  document.querySelectorAll('.run-item').forEach(el => {
    el.style.borderLeft = el.dataset.runId === runId 
      ? '3px solid var(--accent-blue)' 
      : 'none';
  });
}

async function runBacktest() {
  const btn = document.getElementById('run-backtest-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width: 16px; height: 16px; margin: 0;"></div> Running...';
  
  try {
    const result = await postApi('/backtests/run', {});
    
    if (result && result.success) {
      // Refresh data
      await loadData();
      
      // Select the new run
      if (result.runId) {
        await selectRun(result.runId);
      }
    } else {
      alert('Backtest failed. Check console for details.');
    }
  } catch (error) {
    console.error('Backtest error:', error);
    alert('Backtest failed. Check console for details.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>▶</span> Run Backtest';
  }
}

// ============================================
// Initialization
// ============================================

async function loadData() {
  // Health check
  const health = await fetchApi('/health');
  updateStatus(!!health);
  
  if (!health) return;
  
  // Load stats
  const stats = await fetchApi('/stats');
  if (stats) {
    updateStats(stats);
  }
  
  // Load config
  const config = await fetchApi('/config');
  if (config) {
    updateConfig(config);
  }
  
  // Load runs
  const runs = await fetchApi('/backtests');
  if (runs) {
    updateRuns(runs);
    
    // Select most recent run if available
    if (runs.length > 0 && !currentRunId) {
      await selectRun(runs[0].id);
    }
  }
}

async function init() {
  console.log('Initializing Polymarket Backtester Dashboard...');
  
  // Initialize chart
  initEquityChart();
  
  // Load initial data
  await loadData();
  
  // Set up event listeners
  document.getElementById('run-backtest-btn').addEventListener('click', runBacktest);
  
  // Refresh data every 30 seconds
  setInterval(loadData, 30000);
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Expose selectRun globally for onclick handlers
window.selectRun = selectRun;

