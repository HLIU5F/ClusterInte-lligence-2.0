# Enricher 系统（flowsint 风格）

## 架构

```
scripts/enrichers/
├── __init__.py          # 包入口；必须 import 所有 enricher 模块触发注册
├── base.py              # BaseEnricher 抽象基类
├── registry.py          # @enricher 装饰器 + REGISTRY 全局表
├── config.py            # 从 YAML 读启用配置
├── types.py             # Pydantic 实体模型 (IPEntity / SubnetEntity / ...)
├── pipeline.py          # Pipeline 编排器 + CLI 入口
├── ip_geo.py            # IP → 地理位置（RFC1918 / ip-api.com）
├── service_type.py      # 端口集合 → 服务大类（Web / DB / Cache ...）
├── port_service.py      # 端口 → 具体协议（80/HTTP, 3306/MySQL）+ Service 节点
├── subnet_cidr.py       # CIDR → 网段类型（私有 / loopback / multicast）
└── anomaly_score.py     # 度中心性 + is_hub + 端口数 → 异常评分

config/
└── enrichers.yaml       # 启用/禁用 + 参数覆盖

tests/
└── test_enrichers.py    # 22 个单测
```

## 怎么跑

### 1. 装 Python 依赖

```bash
cd D:\桌面\projec\Cluster-Intelligence
pip install pydantic pyyaml pytest neo4j requests
```

### 2. Dry-run（只跑 enricher，不写 Neo4j）

```bash
cd D:\桌面\projec\Cluster-Intelligence
set PYTHONPATH=scripts
python -m scripts.enrichers.pipeline --dry-run
```

输出：每个 enricher 的 scanned / ok / err 统计。

### 3. 跑 enricher + 写 JSON

```bash
cd D:\桌面\projec\Cluster-Intelligence\scripts
python apply_enrichers.py topology_data.json(2) topology_data_enriched.json
```

### 4. 跑 enricher + 写 Neo4j

```bash
cd D:\桌面\projec\Cluster-Intelligence\scripts
python import_to_neo4j.py
```

### 5. 跑单测

```bash
cd D:\桌面\projec\Cluster-Intelligence
set PYTHONPATH=scripts
python -m pytest tests/test_enrichers.py -v
```

## 怎么新增一个 Enricher

### Step 1：写 enricher 文件

在 `scripts/enrichers/` 下新建 `my_enricher.py`：

```python
from .base import BaseEnricher, safe_result
from .registry import enricher
from .types import IPEntity, EnrichmentResult

@enricher
class MyEnricher(BaseEnricher):
    name = "my_enricher"            # 唯一标识
    category = "Custom"             # 分桶用
    description = "做什么的"
    applicable_type = "IP"          # 处理哪种实体

    # 可选：参数（pipeline 从 config.yaml 透传）
    my_param: str = "default"

    def scan(self, entity: IPEntity):
        """采集数据（可 async）"""
        return entity  # 默认什么都不做

    def postprocess(self, raw, entity: IPEntity) -> EnrichmentResult:
        """落数据"""
        return safe_result(properties={
            "my_field": "value",
        })
```

### Step 2：在 `__init__.py` 加一行

```python
from . import my_enricher   # noqa: F401
```

**不这步 → 注册表不会收录，pipeline 不会跑它。**

### Step 3：在 `types.py` 的 `IPEntity` 加字段（如果写了新属性）

```python
my_field: Optional[str] = None
```

### Step 4：在 `config/enrichers.yaml` 可选覆盖参数

```yaml
enrichers:
  my_enricher:
    enabled: true
    params:
      my_param: "custom_value"
```

### Step 5：在 `tests/test_enrichers.py` 加单测

```python
class TestMyEnricher:
    def test_basic(self):
        ent = IPEntity(id="10.1.1.1", ip="10.1.1.1")
        r = MyEnricher().enrich(ent)
        assert r.properties["my_field"] == "value"
```

## 三类产出

每个 enricher 的 `postprocess()` 返回 `EnrichmentResult`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `properties` | `dict` | 写到当前 entity 上的字段 |
| `relationships` | `list[dict]` | 要创建的关系 `[{type, target, target_type}]` |
| `new_entities` | `list[Entity]` | 发现的新实体（进下一轮 BFS） |
| `errors` | `list[str]` | 非致命错误 |

## 内置 Enricher

| name | category | applicable_type | 做什么 |
|---|---|---|---|
| `ip_geo` | Geo | IP | RFC1918 内网识别 + 公网 ip-api.com 查询 |
| `service_type` | Service | IP | 端口集合 → 服务大类（Web/DB/Cache/MQ...） |
| `port_service` | Service | IP | 端口 → 具体协议（80/HTTP）+ 创建 `:Service` 节点 + `:RUNS` 关系 |
| `subnet_cidr` | Network | Subnet | CIDR → 私有/loopback/multicast 判定 |
| `anomaly_score` | Risk | IP | degree + is_hub + 端口数 → 异常评分（pipeline 末尾归一化到 [0,1]） |
