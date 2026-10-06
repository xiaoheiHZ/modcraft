# 模组规格 spec JSON 说明

这是 AI（DeepSeek）输出、由 `modgen/generate.py` 消费的中间格式。

```json
{
  "mod_id": "emerald_workshop",        // 小写字母/数字/下划线，2-24 位
  "mod_name": "绿宝石工坊",             // 中文名
  "description": "English one-liner",  // 英文描述
  "theme": "#34d399",                  // 主题色（贴图生成用）
  "mc_version": "1.20.1",              // 1.20.1 | 1.21.1（Worker 注入）
  "items": [
    {
      "id": "emerald_sword",           // [a-z0-9_]{2,32}
      "name_zh": "绿宝石剑",
      "name_en": "Emerald Sword",
      "kind": "sword",                 // item|sword|pickaxe|axe|shovel|hoe|food|block
      "material": "emerald",           // 可选：配方材料（原版物品 id）
      "base_texture": "diamond_sword", // 可选：贴图基底（原版物品/方块 id）
      "color": "#34d399",              // 可选：贴图调色目标色
      "max_damage": 2000,              // 可选：工具耐久
      "attack": 6,                     // 可选：攻击伤害加成
      "nutrition": 6,                  // food 必填：饥饿值 1-20
      "saturation": 1.2                // 可选：饱和度系数
    }
  ]
}
```

## 生成规则

| kind | 生成内容 |
|---|---|
| item | 普通物品（材料栏） |
| sword / pickaxe / axe / shovel / hoe | 工具，档位由 material 推断（铁/金/钻石/下界合金…；自定义材料按钻石档） |
| food | 食物（饥饿值 + 饱和度） |
| block | 方块 + BlockItem + 方块状态/模型/战利品表 |

- 配方自动生成：工具按原版形状（材料 + 木棍）；方块按 3x3。材料不在白名单时跳过配方。
- 贴图：给定 `base_texture` 时从原版素材镜像下载并做色相迁移（需 Pillow）；否则用主题色生成纯色贴图。
- 版本目录差异自动处理：1.20.1 用 `loot_tables` / `recipes`，1.21+ 用 `loot_table` / `recipe`。
