/* eslint-env node */
// ESLint 8 配置（传统 .eslintrc，兼容生态最稳）
// 规则策略：启用 recommended 基线，但关闭/降级会与本项目既有严格 TS 风格
// 重复或纯格式的噪音规则，目标是让现有 83 个源码文件 `npm run lint` 零 error、
// 仅保留有信号意义的语义/lint 警告。
module.exports = {
  root: true,
  env: {
    browser: true,
    node: true,
    es2022: true,
  },
  parser: 'vue-eslint-parser',
  parserOptions: {
    parser: '@typescript-eslint/parser',
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { vue: true },
  },
  plugins: ['@typescript-eslint', 'vue'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:vue/vue3-recommended',
  ],
  // 排除构建产物、依赖、数据目录以及运行在 Node 环境的构建配置文件
  ignorePatterns: [
    'node_modules',
    'dist',
    'dist-electron',
    'release',
    'build',
    'data',
    '*.config.ts',
    '*.config.js',
    'postcss.config.js',
    'tailwind.config.js',
  ],
  rules: {
    // —— 与 tsc 职责重叠，交 TS 编译器管理，避免双重报错 ——
    '@typescript-eslint/no-unused-vars': 'off',
    'no-unused-vars': 'off',
    '@typescript-eslint/no-explicit-any': 'off', // 运行时边界确有 any 需求
    '@typescript-eslint/no-non-null-assertion': 'off', // 项目惯用 `!`
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-empty-function': 'off',
    '@typescript-eslint/ban-ts-comment': 'off',
    '@typescript-eslint/no-empty-interface': 'off',
    '@typescript-eslint/no-var-requires': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/ban-types': 'off',

    // —— 业务噪音，降级为 warn 不阻断 ——
    'prefer-const': 'warn',
    'no-empty': 'off',
    'no-console': 'off', // 桌面应用调试需要 console
    'no-control-regex': 'off', // 手写 xlsx 生成器需处理控制字符

    // —— Vue 组件命名/prop 规范，本项目从简 ——
    'vue/multi-word-component-names': 'off',
    'vue/no-v-html': 'off',
    'vue/require-default-prop': 'off',
    'vue/no-unused-vars': 'off',
    'vue/comment-directive': 'off',
    'vue/no-reserved-component-names': 'off',
    'vue/require-explicit-emits': 'off',
    'vue/require-prop-types': 'off',

    // —— Vue 纯模板格式规则（噪音大、不反映真实问题，关闭以免淹没信号）——
    'vue/max-attributes-per-line': 'off',
    'vue/multiline-html-element-content-newline': 'off',
    'vue/singleline-html-element-content-newline': 'off',
    'vue/html-self-closing': 'off',
    'vue/html-closing-bracket-newline': 'off',
    'vue/html-closing-bracket-spacing': 'off',
    'vue/html-end-tags': 'off',
    'vue/html-indent': 'off',
    'vue/html-quotes': 'off',
    'vue/attributes-order': 'off',
    'vue/attribute-hyphenation': 'off',
    'vue/component-tags-order': 'off',
    'vue/no-spaces-around-equal-signs-in-attribute': 'off',
    'vue/prop-name-casing': 'off',
    'vue/v-bind-style': 'off',
    'vue/v-on-style': 'off',
    'vue/v-slot-style': 'off',
    'vue/first-attribute-linebreak': 'off',
    'vue/next-tick-async': 'off',
    'vue/padding-line-between-blocks': 'off',
  },
};
