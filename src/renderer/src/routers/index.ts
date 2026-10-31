import { createRouter, createWebHashHistory } from 'vue-router';
import Dashboard from '../views/Dashboard.vue';
import Market from '../views/Market.vue';
import LimitUp from '../views/LimitUp.vue';
import StrategyConfig from '../views/StrategyConfig.vue';
import Backtest from '../views/Backtest.vue';
import StockDetail from '../views/StockDetail.vue';
import Settings from '../views/Settings.vue';
import About from '../views/About.vue';
import Watchlist from '../views/Watchlist.vue';
import Sentiment from '../views/Sentiment.vue';
import Sectors from '../views/Sectors.vue';

const routes = [
  { path: '/', name: 'dashboard', component: Dashboard, meta: { title: '选股仪表盘' } },
  { path: '/market', name: 'market', component: Market, meta: { title: 'A股行情' } },
  { path: '/limitup', name: 'limitup', component: LimitUp, meta: { title: '涨停池' } },
  { path: '/sentiment', name: 'sentiment', component: Sentiment, meta: { title: '市场情绪' } },
  { path: '/sectors', name: 'sectors', component: Sectors, meta: { title: '板块/行业' } },
  { path: '/watchlist', name: 'watchlist', component: Watchlist, meta: { title: '我的自选' } },
  { path: '/strategy', name: 'strategy', component: StrategyConfig, meta: { title: '策略配置' } },
  { path: '/backtest', name: 'backtest', component: Backtest, meta: { title: '回测面板' } },
  { path: '/stock/:code', name: 'stock', component: StockDetail, meta: { title: '个股详情' } },
  { path: '/settings', name: 'settings', component: Settings, meta: { title: '设置' } },
  // fullscreen：关于窗独占整窗（不渲染 App.vue 的 header 导航条）
  { path: '/about', name: 'about', component: About, meta: { title: '关于', fullscreen: true } },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
