# Time and Road

Time and Road 是一个个人旅行知识库，用来长期保存自己研究和旅行过程中积累下来的路线、城市、景点、餐厅、宾馆和备注。

它不是旅行规划工具，也不是公开攻略平台。它更像一本慢慢写下去的旅行笔记：记录那些值得再次出发的地方，以及一路上积累的经验和记忆。

## 功能

- 保存路线和城市顺序
- 记录城市停留天数、关键词、想去原因和备注
- 保存景点、餐厅、宾馆资料
- 使用高德地图显示路线和城市标记
- 使用高德 Web 服务计算路段距离和预计时间
- 整理粘贴的旅行资料，并在确认后保存到城市笔记中

## 启动方式

安装依赖：

```bash
npm install
```

启动本地服务：

```bash
npm start
```

默认访问地址：

```text
http://localhost:4173
```

如果需要指定端口：

```bash
PORT=4212 npm start
```

## 环境变量

地图和距离计算需要配置高德 Key。Key 只应放在本地环境变量中，不要写入代码，也不要提交到 GitHub。

```bash
AMAP_WEB_SERVICE_KEY=你的高德Web服务Key
AMAP_JS_API_KEY=你的高德JSAPIKey
AMAP_SECURITY_JS_CODE=你的高德JS安全密钥
```

示例启动：

```bash
AMAP_WEB_SERVICE_KEY=你的高德Web服务Key \
AMAP_JS_API_KEY=你的高德JSAPIKey \
AMAP_SECURITY_JS_CODE=你的高德JS安全密钥 \
npm start
```

变量说明：

- `AMAP_WEB_SERVICE_KEY`：后端调用高德 Web 服务，用于地理编码和驾车距离计算。
- `AMAP_JS_API_KEY`：后端代理加载高德 JS API，用于前端地图展示。
- `AMAP_SECURITY_JS_CODE`：高德 JS API 安全密钥。

## 数据保存

本地数据默认保存在：

```text
data/notebook.json
```

这个文件包含个人旅行资料，建议不要提交到公开仓库。项目启动时如果文件不存在，会自动创建本地数据文件。

## 提交前检查

提交 GitHub 前建议确认：

- `.env` 没有被提交
- `node_modules` 没有被提交
- `data/notebook.json` 没有被提交到公开仓库
- 代码中没有硬编码任何高德 Key

