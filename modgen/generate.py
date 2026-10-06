#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
方块梦工厂 · Minecraft Fabric 模组生成器
把 AI 生成的 spec JSON 变成一个可以直接 gradle build 的 Fabric 模组工程。

用法:
    python modgen/generate.py --spec spec.json --out project

支持版本: 1.20.1 / 1.21.1 （官方 Mojang 映射 + Fabric Loom 1.18）
"""
import argparse
import colorsys
import io
import json
import os
import re
import shutil
import struct
import sys
import urllib.request
import zlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------- 版本配置
# gen 代码生成代系：
#   A  = 1.20.x（经典工具构造器 / saturationMod / 复数数据目录 / new ResourceLocation）
#   B  = 1.21~1.21.1（属性组件工具 / saturationModifier / 单数目录 / fromNamespaceAndPath）
#   B2 = 1.21.4（ToolMaterial 内联构造器 / 字符串配方材料 / items/ 物品模型目录）
#   C  = 26.x（Identifier / fabric-loom 插件 / Java 25；需付费）
VERSIONS = {
    '1.20':    dict(mc='1.20',    release=17, fabric_api='0.83.0+1.20',       gen='A'),
    '1.20.1':  dict(mc='1.20.1',  release=17, fabric_api='0.92.12+1.20.1',    gen='A'),
    '1.20.2':  dict(mc='1.20.2',  release=17, fabric_api='0.91.6+1.20.2',     gen='A'),
    '1.20.4':  dict(mc='1.20.4',  release=17, fabric_api='0.97.3+1.20.4',     gen='A'),
    '1.20.5':  dict(mc='1.20.5',  release=21, fabric_api='0.97.8+1.20.5',     gen='A2'),
    '1.20.6':  dict(mc='1.20.6',  release=21, fabric_api='0.100.8+1.20.6',    gen='A2'),
    '1.21':    dict(mc='1.21',    release=21, fabric_api='0.102.0+1.21',      gen='B'),
    '1.21.1':  dict(mc='1.21.1',  release=21, fabric_api='0.116.17+1.21.1',   gen='B'),
    '1.21.2':  dict(mc='1.21.2',  release=21, fabric_api='0.106.1+1.21.2',    gen='B2x'),
    '1.21.3':  dict(mc='1.21.3',  release=21, fabric_api='0.114.1+1.21.3',    gen='B2x'),
    '1.21.4':  dict(mc='1.21.4',  release=21, fabric_api='0.119.4+1.21.4',    gen='B2'),
    '1.21.5':  dict(mc='1.21.5',  release=21, fabric_api='0.128.2+1.21.5',    gen='B3'),
    '1.21.6':  dict(mc='1.21.6',  release=21, fabric_api='0.128.2+1.21.6',    gen='B3'),
    '1.21.7':  dict(mc='1.21.7',  release=21, fabric_api='0.129.0+1.21.7',    gen='B3'),
    '1.21.8':  dict(mc='1.21.8',  release=21, fabric_api='0.136.1+1.21.8',    gen='B3'),
    '1.21.9':  dict(mc='1.21.9',  release=21, fabric_api='0.134.1+1.21.9',    gen='B3'),
    '1.21.10': dict(mc='1.21.10', release=21, fabric_api='0.138.4+1.21.10',   gen='B3'),
    '1.21.11': dict(mc='1.21.11', release=21, fabric_api='0.141.6+1.21.11',   gen='C1'),
    '26.1':    dict(mc='26.1',    release=25, fabric_api='0.145.1+26.1',      gen='C'),
    '26.2':    dict(mc='26.2',    release=25, fabric_api='0.161.0+26.2',      gen='C'),
    '26.3':    dict(mc='26.3',    release=25, fabric_api='0.161.0+26.3',      gen='C'),
}
GEN_CAPS = {
    'A':   dict(tool_style='old',      food_method='saturationMod',      recipe_style='v1',
                data_dirs='plural',   items_folder=False, id_style='ctor',
                plugin='net.fabricmc.fabric-loom-remap', mappings_line=True,
                dep_style='mod',      tab_style='entries', armor_style='classic', premium=False),
    'A2':  dict(tool_style='attrs',    food_method='saturationModifier', recipe_style='v2',
                data_dirs='plural',   items_folder=False, id_style='ctor',
                plugin='net.fabricmc.fabric-loom-remap', mappings_line=True,
                dep_style='mod',      tab_style='entries', armor_style='holder',  premium=False),
    'B':   dict(tool_style='attrs',    food_method='saturationModifier', recipe_style='v2',
                data_dirs='singular', items_folder=False, id_style='fromNS',
                plugin='net.fabricmc.fabric-loom-remap', mappings_line=True,
                dep_style='mod',      tab_style='entries', armor_style='classic', premium=False),
    'B2x': dict(tool_style='modern',   food_method='saturationModifier', recipe_style='v3',
                data_dirs='singular', items_folder=False, id_style='fromNS',
                plugin='net.fabricmc.fabric-loom-remap', mappings_line=True,
                dep_style='mod',      tab_style='entries', armor_style='equipclass', premium=False),
    'B2':  dict(tool_style='modern',   food_method='saturationModifier', recipe_style='v3',
                data_dirs='singular', items_folder=True,  id_style='fromNS',
                plugin='net.fabricmc.fabric-loom-remap', mappings_line=True,
                dep_style='mod',      tab_style='entries', armor_style='equipclass', premium=False),
    'B3':  dict(tool_style='classic26', food_method='saturationModifier', recipe_style='v3',
                data_dirs='singular', items_folder=True,  id_style='fromNS',
                plugin='net.fabricmc.fabric-loom-remap', mappings_line=True,
                dep_style='mod',      tab_style='entries', armor_style='equipprops', premium=False),
    'C1':  dict(tool_style='classic26', food_method='saturationModifier', recipe_style='v3',
                data_dirs='singular', items_folder=True,  id_style='idclass',
                plugin='net.fabricmc.fabric-loom-remap', mappings_line=True,
                dep_style='mod',      tab_style='entries', armor_style='equipprops', premium=False),
    'C':   dict(tool_style='classic26', food_method='saturationModifier', recipe_style='v3',
                data_dirs='singular', items_folder=True,  id_style='idclass',
                plugin='net.fabricmc.fabric-loom',      mappings_line=False,
                dep_style='impl',     tab_style='output', armor_style='equipprops', premium=True),
}
DEFAULT_VERSION = '1.20.1'
LOADER = '0.19.5'
LOOM = '1.18-SNAPSHOT'

TEX_CDNS = [
    'https://cdn.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@{ver}/assets/minecraft/',
    'https://fastly.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@{ver}/assets/minecraft/',
    'https://gcore.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@{ver}/assets/minecraft/',
    'https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/{ver}/assets/minecraft/',
]

# 允许作为配方材料的原版物品（不在列表里的会被忽略，避免生成打不开的配方）
SAFE_ITEMS = set("""
stick coal charcoal iron_ingot gold_ingot copper_ingot diamond emerald
netherite_ingot netherite_scrap lapis_lazuli redstone quartz amethyst_shard echo_shard
iron_nugget gold_nugget raw_iron raw_copper raw_gold bone bone_meal gunpowder string
leather feather flint clay_ball brick nether_brick paper sugar slime_ball magma_cream
blaze_rod blaze_powder breeze_rod ender_pearl ender_eye glowstone_dust ghast_tear
phantom_membrane shulker_shell nautilus_shell prismarine_shard prismarine_crystals
dragon_breath nether_wart rabbit_hide rabbit_foot scute ink_sac glow_ink_sac
honeycomb honey_bottle snowball egg wheat wheat_seeds apple potato carrot beetroot
melon_slice sweet_berries glow_berries oak_planks spruce_planks birch_planks
jungle_planks acacia_planks dark_oak_planks mangrove_planks cherry_planks
bamboo_planks crimson_planks warped_planks bamboo cobblestone stone deepslate
blackstone obsidian glass sand dirt gravel netherrack end_stone copper_block
iron_block gold_block diamond_block emerald_block netherite_block lapis_block
redstone_block coal_block quartz_block amethyst_block honey_block slime_block hay_block
""".split())

DURABILITY = {'WOOD': 59, 'STONE': 131, 'IRON': 250, 'GOLD': 32, 'DIAMOND': 1561, 'NETHERITE': 2031}
TOOL_CLASS = {'sword': 'SwordItem', 'pickaxe': 'PickaxeItem', 'axe': 'AxeItem', 'shovel': 'ShovelItem', 'hoe': 'HoeItem'}
TOOL_DMG = {'sword': 3, 'pickaxe': 1, 'axe': 5, 'shovel': 1, 'hoe': 0}
TOOL_SPD = {'sword': -2.4, 'pickaxe': -2.8, 'axe': -3.0, 'shovel': -3.0, 'hoe': -3.0}
TOOL_GROUP = {'sword': 'COMBAT', 'pickaxe': 'TOOLS_AND_UTILITIES', 'axe': 'TOOLS_AND_UTILITIES',
              'shovel': 'TOOLS_AND_UTILITIES', 'hoe': 'TOOLS_AND_UTILITIES'}
ARMOR_KINDS = ('helmet', 'chestplate', 'leggings', 'boots')
ARMOR_TYPE = {'helmet': 'HELMET', 'chestplate': 'CHESTPLATE', 'leggings': 'LEGGINGS', 'boots': 'BOOTS'}

def pick_armor_material(material):
    m = (material or '').lower()
    if m in ('netherite_ingot', 'netherite_scrap'):
        return 'NETHERITE'
    if m in ('iron_ingot', 'iron_nugget', 'chainmail'):
        return 'IRON'
    if m in ('gold_ingot', 'gold_nugget'):
        return 'GOLD'
    if m == 'leather':
        return 'LEATHER'
    return 'DIAMOND'

TAB_IDS = {'COMBAT': 'combat', 'TOOLS_AND_UTILITIES': 'tools_and_utilities',
           'FOOD_AND_DRINKS': 'food_and_drinks', 'INGREDIENTS': 'ingredients',
           'BUILDING_BLOCKS': 'building_blocks'}
RECIPE_SHAPES = {
    'sword': ['X', 'X', 'S'],
    'pickaxe': ['XXX', ' S ', ' S '],
    'axe': ['XX', 'XS', ' S'],
    'shovel': ['X', 'S', 'S'],
    'hoe': ['XX', ' S', ' S'],
}


# ---------------------------------------------------------------- 小工具
def hex_to_rgb(s):
    s = (s or '#34d399').lstrip('#')
    if len(s) != 6:
        s = '34d399'
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


def shift_theme(theme_hex, idx):
    """按物品序号旋转主题色，得到和谐但不同的颜色。"""
    r, g, b = hex_to_rgb(theme_hex)
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    h = (h + idx * 0.103) % 1.0
    r, g, b = colorsys.hsv_to_rgb(h, s, v)
    return '#%02x%02x%02x' % (int(r * 255), int(g * 255), int(b * 255))


def png_bytes(w, h, rows):
    """纯 Python 写 PNG（不需要 Pillow）。rows: [[(r,g,b,a), ...], ...]"""
    raw = b''.join(b'\x00' + bytes(c for px in row for c in px) for row in rows)

    def chunk(typ, data):
        return struct.pack('>I', len(data)) + typ + data + struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff)

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


def synth_png(hexcolor):
    """没有贴图基底时，生成一个 16x16 的像素小方块贴图。"""
    r, g, b = hex_to_rgb(hexcolor)
    rows = []
    for y in range(16):
        row = []
        for x in range(16):
            if x in (0, 15) or y in (0, 15):
                f = 0.42          # 边框阴影
            elif x == 1 or y == 1:
                f = 1.35          # 左上高光
            else:
                f = 1.0 + 0.10 * (1 - y / 16.0)   # 轻微纵向渐变
            row.append((min(255, int(r * f)), min(255, int(g * f)), min(255, int(b * f)), 255))
        rows.append(row)
    return png_bytes(16, 16, rows)


def tint_png(data, hexcolor):
    """有了基底贴图后，把色相拉向目标颜色（需要 Pillow；不装则原样返回）。"""
    try:
        from PIL import Image
    except Exception:
        return data
    try:
        tr, tg, tb = hex_to_rgb(hexcolor)
        th, _, _ = colorsys.rgb_to_hsv(tr / 255, tg / 255, tb / 255)
        img = Image.open(io.BytesIO(data)).convert('RGBA')
        px = img.load()
        w, h = img.size
        for y in range(h):
            for x in range(w):
                r, g, b, a = px[x, y]
                if a == 0:
                    continue
                hh, ss, vv = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
                nh = hh * 0.3 + th * 0.7          # 拉向目标色相
                ns = max(0.0, min(1.0, ss * 0.45 + 0.35))
                nr, ng, nb = colorsys.hsv_to_rgb(nh, ns, vv)   # 保留原明暗
                px[x, y] = (int(nr * 255), int(ng * 255), int(nb * 255), a)
        out = io.BytesIO()
        img.save(out, 'PNG')
        return out.getvalue()
    except Exception:
        return data


def download_texture(mc_version, rel_paths, timeout=25):
    for cdn in TEX_CDNS:
        base = cdn.format(ver=mc_version)
        for rel in rel_paths:
            url = base + rel
            try:
                req = urllib.request.Request(url, headers={'User-Agent': 'BlockDream/0.1'})
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    if resp.status == 200:
                        data = resp.read()
                        if data[:8] == b'\x89PNG\r\n\x1a\n':
                            print(f'      ↓ 贴图基底 {rel}')
                            return data
            except Exception:
                continue
    return None


def pick_tier(material):
    m = (material or '').lower()
    if m in ('netherite_ingot', 'netherite_scrap'):
        return 'NETHERITE', 'netherite_ingot'
    if m == 'diamond':
        return 'DIAMOND', 'diamond'
    if m in ('gold_ingot', 'gold_nugget'):
        return 'GOLD', 'gold_ingot'
    if m in ('iron_ingot', 'iron_nugget'):
        return 'IRON', 'iron_ingot'
    if m in ('stone', 'cobblestone'):
        return 'STONE', 'stone'
    if m.endswith('_planks') or m == 'stick':
        return 'WOOD', 'oak_planks'
    return 'DIAMOND', (m if m in SAFE_ITEMS else 'diamond')


def sanitize_id(s, fallback='dream_item'):
    s = re.sub(r'[^a-z0-9_]', '_', str(s or '').lower()).strip('_')
    s = re.sub(r'_+', '_', s)
    if not re.match(r'^[a-z][a-z0-9_]{1,31}$', s):
        return fallback
    return s


# ---------------------------------------------------------------- 模板
SETTINGS_GRADLE = '''pluginManagement {
	repositories {
		maven {
			name = 'Fabric'
			url = 'https://maven.fabricmc.net/'
		}
		mavenCentral()
		gradlePluginPortal()
	}
}

rootProject.name = '@MODID@'
'''

BUILD_GRADLE = '''plugins {
	id '@PLUGIN@' version "${loom_version}"
	id 'maven-publish'
}

loom {
	splitEnvironmentSourceSets()

	mods {
		"@MODID@" {
			sourceSet sourceSets.main
			sourceSet sourceSets.client
		}
	}
}

dependencies {
	minecraft "com.mojang:minecraft:${project.minecraft_version}"
@MAPPINGS_BLOCK@	@DEPPFX@ "net.fabricmc:fabric-loader:${project.loader_version}"

	// Fabric API. This is technically optional, but you probably want it anyway.
	@DEPPFX@ "net.fabricmc.fabric-api:fabric-api:${project.fabric_api_version}"
}

processResources {
	def version = project.version
	inputs.property "version", version
	filesMatching("fabric.mod.json") {
		expand "version": version
	}
}

tasks.withType(JavaCompile).configureEach {
	it.options.release = @RELEASE@
	it.options.encoding = 'UTF-8'
}

java {
	withSourcesJar()
	sourceCompatibility = JavaVersion.VERSION_@RELEASE@
	targetCompatibility = JavaVersion.VERSION_@RELEASE@
}
'''

GRADLE_PROPERTIES = '''org.gradle.jvmargs=-Xmx2G
org.gradle.parallel=true
org.gradle.configuration-cache=false

minecraft_version=@MC@
loader_version=@LOADER@
loom_version=@LOOM@

version=1.0.0
group=com.blockdream

fabric_api_version=@FAPI@
'''

GRADLE_WRAPPER_PROPERTIES = '''distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=@DIST@
networkTimeout=30000
retries=1
retryBackOffMs=1000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
'''

DEFAULT_GRADLE_DIST = 'https://services.gradle.org/distributions/gradle-9.7.1-bin.zip'

FABRIC_MOD_JSON = '''{
	"schemaVersion": 1,
	"id": "@MODID@",
	"version": "${version}",
	"name": "@NAME@",
	"description": "@DESC@",
	"authors": [
		"ModCraft 方块梦工厂"
	],
	"license": "MIT",
	"environment": "*",
	"entrypoints": {
		"main": [
			"@PKG@.@CLS@"
		]
	},
	"depends": {
		"fabricloader": ">=@LOADER@",
		"minecraft": "~@MC@",
		"java": ">=@RELEASE@",
		"fabric-api": "*"
	}
}
'''

MAIN_CLASS = '''package @PKG@;

import net.fabricmc.api.ModInitializer;
@EXTRA_IMPORTS@
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.@IDCLASS@;
import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.*;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.state.BlockBehaviour;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;

public class @CLS@ implements ModInitializer {
	public static final String MOD_ID = "@MODID@";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);
	private static final List<Item> ALL_ITEMS = new ArrayList<>();

	public static @IDCLASS@ id(String path) {
@ID_BODY@
	}

	private static <T extends Item> T register(String name, T item) {
		ALL_ITEMS.add(item);
		return Registry.register(BuiltInRegistries.ITEM, id(name), item);
	}

	@Override
	public void onInitialize() {
@BODY@
		LOGGER.info("{} loaded, {} items registered.", "@NAME@", ALL_ITEMS.size());
	}
}
'''

LICENSE_TEXT = '''MIT License

Copyright (c) 2026 ModCraft 方块梦工厂 (generated mod)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
'''


# ---------------------------------------------------------------- Java 代码生成
def build_java_body(spec, cfg):
    lines = []
    groups = {}
    for idx, it in enumerate(spec['items']):
        vid = it['id']
        var = vid.upper()
        kind = it['kind']
        if kind == 'item':
            lines.append(f'\t\tItem {var} = register("{vid}", new Item(new Item.Properties()));')
            groups.setdefault('INGREDIENTS', []).append(var)
        elif kind in TOOL_CLASS:
            tier, _ = pick_tier(it.get('material'))
            dur = int(it.get('max_damage') or DURABILITY[tier])
            dmg = int(it.get('attack') or TOOL_DMG[kind])
            spd = TOOL_SPD[kind]
            props = f'new Item.Properties().stacksTo(1).durability({dur})'
            style = cfg['tool_style']
            if style == 'attrs':                      # B：属性组件写法
                if kind == 'sword':
                    props += f'.attributes(SwordItem.createAttributes(Tiers.{tier}, {dmg}, {spd}F))'
                else:
                    props += f'.attributes(DiggerItem.createAttributes(Tiers.{tier}, {dmg}, {spd}F))'
                ctor = f'new {TOOL_CLASS[kind]}(Tiers.{tier}, {props})'
            elif style == 'modern':                   # B2 / C：ToolMaterial 内联构造器
                ctor = f'new {TOOL_CLASS[kind]}(ToolMaterial.{tier}, {dmg}, {spd}F, {props})'
            elif style == 'classic26':                # 26.x：剑/镐用 Properties 内联，其余用现有类
                if kind in ('sword', 'pickaxe'):
                    ctor = f'new Item(new Item.Properties().{kind}(ToolMaterial.{tier}, {dmg}F, {spd}F))'
                else:
                    ctor = f'new {TOOL_CLASS[kind]}(ToolMaterial.{tier}, {dmg}F, {spd}F, new Item.Properties())'
            else:                                     # A：经典构造器
                ctor = f'new {TOOL_CLASS[kind]}(Tiers.{tier}, {dmg}, {spd}F, {props})'
            lines.append(f'\t\tItem {var} = register("{vid}", {ctor});')
            groups.setdefault(TOOL_GROUP[kind], []).append(var)
        elif kind in ARMOR_KINDS:
            mat = pick_armor_material(it.get('material'))
            slot = ARMOR_TYPE[kind]
            astyle = cfg['armor_style']
            if astyle in ('classic', 'holder'):     # 1.20~1.21.1：ArmorItem + ArmorItem.Type
                ctor = f'new ArmorItem(ArmorMaterials.{mat}, ArmorItem.Type.{slot}, new Item.Properties())'
            elif astyle == 'equipclass':            # 1.21.2~1.21.4：equipment 包
                ctor = f'new ArmorItem(ArmorMaterials.{mat}, ArmorType.{slot}, new Item.Properties())'
            else:                                    # equipprops：1.21.5+/26.x 纯 Item
                ctor = f'new Item(new Item.Properties().humanoidArmor(ArmorMaterials.{mat}, ArmorType.{slot}))'
            lines.append(f'\t\tItem {var} = register("{vid}", {ctor});')
            groups.setdefault('COMBAT', []).append(var)
        elif kind == 'food':
            n = int(it.get('nutrition') or 4)
            s = float(it.get('saturation') or 0.6)
            sat = f"{cfg['food_method']}({s}F)"
            lines.append(
                f'\t\tItem {var} = register("{vid}", new Item(new Item.Properties().food('
                f'new FoodProperties.Builder().nutrition({n}).{sat}.build())));')
            groups.setdefault('FOOD_AND_DRINKS', []).append(var)
        elif kind == 'block':
            lines.append(
                f'\t\tBlock {var}_BLOCK = Registry.register(BuiltInRegistries.BLOCK, id("{vid}"), '
                f'new Block(BlockBehaviour.Properties.of().strength(3.0F).sound(SoundType.STONE)));')
            lines.append(f'\t\tItem {var} = register("{vid}", new BlockItem({var}_BLOCK, new Item.Properties()));')
            groups.setdefault('BUILDING_BLOCKS', []).append(var)
    if groups:
        lines.append('')
    if cfg['tab_style'] == 'output':
        for group, vars in groups.items():
            gid = TAB_IDS.get(group, group.lower())
            lines.append(
                '\t\tCreativeModeTabEvents.modifyOutputEvent(ResourceKey.create(Registries.CREATIVE_MODE_TAB, '
                'Identifier.fromNamespaceAndPath("minecraft", "' + gid + '"))).register(output -> {')
            for v in vars:
                lines.append('\t\t\toutput.accept(new ItemStack(' + v + '), CreativeModeTab.TabVisibility.PARENT_AND_SEARCH_TABS);')
            lines.append('\t\t});')
    else:
        for group, vars in groups.items():
            lines.append('\t\tItemGroupEvents.modifyEntriesEvent(CreativeModeTabs.' + group + ').register(entries -> {')
            for v in vars:
                lines.append('\t\t\tentries.accept(new ItemStack(' + v + '));')
            lines.append('\t\t});')
    return '\n'.join(lines)


def make_recipe(ns, it, cfg):
    kind, vid = it['kind'], it['id']
    material = it.get('material')
    if material and material not in SAFE_ITEMS:
        print(f'      ! 材料 {material} 不在安全列表，跳过配方')
        material = None
    if not material:
        return None
    if kind in RECIPE_SHAPES:
        pattern = RECIPE_SHAPES[kind]
        category = 'equipment'
    elif kind == 'block':
        pattern = ['XXX', 'XXX', 'XXX']
        category = 'building'
    else:
        return None
    style = cfg['recipe_style']
    if style == 'v1':
        result = {'item': f'{ns}:{vid}', 'count': 1}
        key_ing = lambda m: {'item': f'minecraft:{m}'}
    else:
        result = {'id': f'{ns}:{vid}', 'count': 1}
        key_ing = (lambda m: f'minecraft:{m}') if style == 'v3' else (lambda m: {'item': f'minecraft:{m}'})
    out = {
        'type': 'minecraft:crafting_shaped',
        'category': category,
        'key': {'X': key_ing(material), 'S': key_ing('stick')},
        'pattern': pattern,
        'result': result,
    }
    if 'S' not in ''.join(pattern):
        del out['key']['S']
    if style == 'v1':
        out['show_notification'] = True
    return out


def make_loot(ns, it):
    return {
        'type': 'minecraft:block',
        'pools': [{
            'rolls': 1.0,
            'bonus_rolls': 0.0,
            'entries': [{'type': 'minecraft:item', 'name': f'{ns}:{it["id"]}'}],
        }],
        'random_sequence': f'{ns}:blocks/{it["id"]}',
    }


# ---------------------------------------------------------------- 主流程
def generate(spec_path, out_dir):
    spec = json.loads(Path(spec_path).read_text(encoding='utf-8'))
    mc_version = spec.get('mc_version') if spec.get('mc_version') in VERSIONS else DEFAULT_VERSION
    base = dict(VERSIONS[mc_version])
    cfg = dict(base)
    cfg.update(GEN_CAPS[base['gen']])
    cfg['loader'] = LOADER
    cfg['loom'] = LOOM
    cfg['loot_dir'] = 'loot_tables' if cfg['data_dirs'] == 'plural' else 'loot_table'
    cfg['recipe_dir'] = 'recipes' if cfg['data_dirs'] == 'plural' else 'recipe'

    mod_id = sanitize_id(spec.get('mod_id'), 'dream_mod')
    if len(mod_id) < 2:
        mod_id = 'dream_mod'
    mod_name = str(spec.get('mod_name') or '梦想模组')[:24]
    description = str(spec.get('description') or 'Generated by BlockDream.')[:200].replace('"', "'")
    theme = spec.get('theme') or '#34d399'
    items = [it for it in (spec.get('items') or []) if isinstance(it, dict)]
    if not items:
        raise SystemExit('spec 里没有任何物品，无法生成')

    ns = mod_id
    pkg = f'com.blockdream.{mod_id}'
    cls = ''.join(p.capitalize() for p in mod_id.split('_')) or 'Dream'
    cls += 'Mod'

    out = Path(out_dir)
    if out.exists():
        shutil.rmtree(out)
    res = out / 'src/main/resources'
    java_dir = out / 'src/main/java' / Path(pkg.replace('.', '/'))
    assets = res / 'assets' / ns
    data = res / 'data' / ns
    for d in (java_dir, assets / 'lang', assets / 'models/item', assets / 'models/block',
              assets / 'blockstates', assets / 'textures/item', assets / 'textures/block',
              assets / 'items', data / cfg['recipe_dir'], data / cfg['loot_dir'] / 'blocks'):
        d.mkdir(parents=True, exist_ok=True)

    print(f'== 生成模组 {mod_name} ({mod_id}) for {mc_version} ==')

    # ---------- Java ----------
    id_class = 'Identifier' if cfg['id_style'] == 'idclass' else 'ResourceLocation'
    if cfg['id_style'] == 'ctor':
        id_body = '\t\treturn new ResourceLocation(MOD_ID, path);'
    elif cfg['id_style'] == 'fromNS':
        id_body = '\t\treturn ResourceLocation.fromNamespaceAndPath(MOD_ID, path);'
    else:
        id_body = '\t\treturn Identifier.fromNamespaceAndPath(MOD_ID, path);'
    body = build_java_body({'items': items}, cfg)
    equipment_imports = ''
    if cfg['armor_style'] in ('equipclass', 'equipprops'):
        equipment_imports = ('\nimport net.minecraft.world.item.equipment.ArmorMaterials;'
                             '\nimport net.minecraft.world.item.equipment.ArmorType;')
    if cfg['tab_style'] == 'output':
        extra_imports = ('import net.fabricmc.fabric.api.creativetab.v1.CreativeModeTabEvents;\n'
                         'import net.minecraft.core.registries.Registries;\n'
                         'import net.minecraft.resources.ResourceKey;' + equipment_imports)
    else:
        extra_imports = 'import net.fabricmc.fabric.api.itemgroup.v1.ItemGroupEvents;' + equipment_imports
    java_src = (MAIN_CLASS
                .replace('@PKG@', pkg)
                .replace('@CLS@', cls)
                .replace('@MODID@', mod_id)
                .replace('@NAME@', mod_name)
                .replace('@EXTRA_IMPORTS@', extra_imports)
                .replace('@IDCLASS@', id_class)
                .replace('@ID_BODY@', id_body)
                .replace('@BODY@', body))
    (java_dir / f'{cls}.java').write_text(java_src, encoding='utf-8')

    # ---------- fabric.mod.json ----------
    fmj = (FABRIC_MOD_JSON
           .replace('@MODID@', mod_id)
           .replace('@NAME@', mod_name)
           .replace('@DESC@', description)
           .replace('@PKG@', pkg)
           .replace('@CLS@', cls)
           .replace('@MC@', mc_version)
           .replace('@LOADER@', cfg['loader'])
           .replace('@RELEASE@', str(cfg['release'])))
    (res / 'fabric.mod.json').write_text(fmj, encoding='utf-8')

    # ---------- gradle ----------
    (out / 'settings.gradle').write_text(SETTINGS_GRADLE.replace('@MODID@', mod_id), encoding='utf-8')
    (out / 'build.gradle').write_text(
        BUILD_GRADLE
        .replace('@MODID@', mod_id)
        .replace('@RELEASE@', str(cfg['release']))
        .replace('@PLUGIN@', cfg['plugin'])
        .replace('@DEPPFX@', 'modImplementation' if cfg['dep_style'] == 'mod' else 'implementation')
        .replace('@MAPPINGS_BLOCK@', ('\tmappings loom.officialMojangMappings()\n' if cfg['mappings_line'] else '')),
        encoding='utf-8')
    gp = (GRADLE_PROPERTIES
          .replace('@MC@', cfg['mc'])
          .replace('@LOADER@', cfg['loader'])
          .replace('@LOOM@', cfg['loom'])
          .replace('@FAPI@', cfg['fabric_api']))
    (out / 'gradle.properties').write_text(gp, encoding='utf-8')
    (out / 'LICENSE').write_text(LICENSE_TEXT, encoding='utf-8')

    # ---------- gradle wrapper ----------
    wrapper_src = REPO_ROOT / 'templates' / 'wrapper'
    if not (wrapper_src / 'gradle' / 'wrapper' / 'gradle-wrapper.jar').exists():
        raise SystemExit(f'缺少 gradle wrapper 模板：{wrapper_src}（仓库里应当有 templates/wrapper/）')
    shutil.copytree(wrapper_src, out, dirs_exist_ok=True)
    # 国内网络可通过环境变量 GRADLE_DIST_URL 换成镜像（如 https://mirrors.cloud.tencent.com/gradle/gradle-9.7.1-bin.zip）
    dist_url = os.environ.get('GRADLE_DIST_URL') or DEFAULT_GRADLE_DIST
    dist_escaped = dist_url.replace(':', '\\:')
    (out / 'gradle/wrapper/gradle-wrapper.properties').write_text(
        GRADLE_WRAPPER_PROPERTIES.replace('@DIST@', dist_escaped), encoding='utf-8')
    try:
        (out / 'gradlew').chmod(0o755)
    except Exception:
        pass

    # ---------- 语言文件 ----------
    zh, en = {}, {}
    for it in items:
        vid = it['id']
        key = ('block.' if it['kind'] == 'block' else 'item.') + f'{ns}.{vid}'
        zh[key] = it.get('name_zh') or vid
        en[key] = it.get('name_en') or vid
    (assets / 'lang' / 'zh_cn.json').write_text(json.dumps(zh, ensure_ascii=False, indent=2), encoding='utf-8')
    (assets / 'lang' / 'en_us.json').write_text(json.dumps(en, ensure_ascii=False, indent=2), encoding='utf-8')

    # ---------- 模型 / 方块状态 / 贴图 / 配方 / 战利品 ----------
    for idx, it in enumerate(items):
        vid, kind = it['id'], it['kind']
        # 贴图
        folder = 'block' if kind == 'block' else 'item'
        tex_dir = assets / 'textures' / folder
        data_png = None
        bt = it.get('base_texture')
        if bt:
            data_png = download_texture(mc_version, [f'textures/item/{bt}.png', f'textures/block/{bt}.png'])
        color = it.get('color') or shift_theme(theme, idx)
        if data_png:
            data_png = tint_png(data_png, color)
        if not data_png:
            data_png = synth_png(color)
        (tex_dir / f'{vid}.png').write_bytes(data_png)

        # 物品模型
        if kind == 'block':
            (assets / 'blockstates' / f'{vid}.json').write_text(json.dumps({
                'variants': {'': {'model': f'{ns}:block/{vid}'}},
            }, indent=2), encoding='utf-8')
            (assets / 'models/block' / f'{vid}.json').write_text(json.dumps({
                'parent': 'minecraft:block/cube_all',
                'textures': {'all': f'{ns}:block/{vid}'},
            }, indent=2), encoding='utf-8')
            if not cfg['items_folder']:
                (assets / 'models/item' / f'{vid}.json').write_text(json.dumps({
                    'parent': f'{ns}:block/{vid}',
                }, indent=2), encoding='utf-8')
            else:
                (assets / 'items' / f'{vid}.json').write_text(json.dumps({
                    'model': {'type': 'minecraft:model', 'model': f'{ns}:block/{vid}'},
                }, indent=2), encoding='utf-8')
            (data / cfg['loot_dir'] / 'blocks' / f'{vid}.json').write_text(
                json.dumps(make_loot(ns, it), indent=2), encoding='utf-8')
        else:
            parent = 'minecraft:item/handheld' if kind in TOOL_CLASS else 'minecraft:item/generated'
            (assets / 'models/item' / f'{vid}.json').write_text(json.dumps({
                'parent': parent,
                'textures': {'layer0': f'{ns}:item/{vid}'},
            }, indent=2), encoding='utf-8')
            if cfg['items_folder']:
                (assets / 'items' / f'{vid}.json').write_text(json.dumps({
                    'model': {'type': 'minecraft:model', 'model': f'{ns}:item/{vid}'},
                }, indent=2), encoding='utf-8')

        # 配方
        recipe = make_recipe(ns, it, cfg)
        if recipe:
            (data / cfg['recipe_dir'] / f'{vid}.json').write_text(
                json.dumps(recipe, indent=2), encoding='utf-8')

    # ---------- 工程说明 ----------
    (out / 'README.md').write_text(
        f'# {mod_name}\n\n由「ModCraft 方块梦工厂」自动生成。\n\n'
        f'- mod_id: `{mod_id}`\n- Minecraft: `{mc_version}` (Fabric)\n'
        f'- 本地构建: `./gradlew build`（产物在 `build/libs/`）\n',
        encoding='utf-8')

    print(f'== 完成：{out} ==')
    print(f'   物品 {len(items)} 个 · Java {cfg["release"]} · gradle 9.7.1')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--spec', required=True, help='spec JSON 路径')
    ap.add_argument('--out', required=True, help='输出工程目录')
    args = ap.parse_args()
    try:
        generate(args.spec, args.out)
    except SystemExit:
        raise
    except Exception as e:
        print(f'ERROR: {e}', file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
