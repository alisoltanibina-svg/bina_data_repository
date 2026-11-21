"""Explorer dimension parsing and safe module catalog SQL (no database side effects)."""
import csv
import json
import re


def dimension_values(raw):
    if raw is None or raw == '':
        return {}
    if isinstance(raw, dict):
        return {str(k): str(v) for k, v in raw.items() if v is not None}
    text = str(raw).strip()
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        parsed = None
    if isinstance(parsed, dict):
        return dimension_values(parsed)
    if not (text.startswith('{') and text.endswith('}')):
        raise ValueError('Invalid dim_cat_values')
    result = {}
    for pair in next(csv.reader([text[1:-1]], skipinitialspace=True)):
        key, sep, value = pair.partition(':')
        key, value = key.strip().strip('\"\''), value.strip().strip('\"\'')
        if not sep or not key or not value or key in result:
            raise ValueError('Invalid dimension entry')
        result[key] = value
    return result


def dimension_names(raw):
    if raw is None or raw == '':
        return []
    if isinstance(raw, (list, tuple)):
        return list(dict.fromkeys(str(v).strip() for v in raw if str(v).strip()))
    text = str(raw).strip()
    if text.startswith('['):
        return dimension_names(json.loads(text))
    return list(dict.fromkeys(v.strip().strip('\"\'') for v in
        next(csv.reader([text.strip('{}')], skipinitialspace=True)) if v.strip()))


def monitor_module(row):
    name = str(row.get('module_name') or '').replace('‌', '').replace(' ', '').lower()
    return name in {'monitorindicators', 'نماگرهایدیدهبان', 'شاخصهایدیدهبان'}


def location_module(row):
    name = str(row.get('module_name') or '').replace('‌', '').replace(' ', '').lower()
    reference = str(row.get('ref_table') or '').strip().lower()
    return name in {'locationinformation', 'اطلاعاتمکانی', 'اطلاعاتمکان'} or reference in {
        'poi', 'poi_explorecat', 'poi.poi_explorecat', 'poi_places', 'poi.poi_places'}


def resolve_module_mapping(module):
    """Resolve optional mappings in memory; never write defaults to the database."""
    resolved = dict(module)
    for role in ('ref_table', 'topic', 'subtopic', 'indicator', 'filter'):
        resolved[role] = str(module.get(role) or '').strip()
    # Imported unquoted references follow PostgreSQL's lowercase identifier rule.
    # Normalize before both information_schema lookup and quoted SQL generation.
    parts = [part.strip() for part in resolved['ref_table'].split('.')]
    if len(parts) in (1, 2) and all(re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', part) for part in parts):
        resolved['ref_table'] = '.'.join(part.lower() for part in parts)
    if monitor_module(resolved):
        resolved['ref_table'] = resolved['ref_table'] or 'kdescription'
        # These defaults describe only the existing Monitor metadata table.
        if resolved['ref_table'] in ('kdescription', 'analytics.kdescription'):
            defaults = {'topic': 'topic_name', 'subtopic': 'subtopic_name',
                        'indicator': 'indicator_name', 'filter': 'dimensions'}
            for role, column in defaults.items():
                resolved[role] = resolved[role] or column
    return resolved


def catalog_sql(module, columns):
    """Empty mappings are optional; explicit SQL identifiers remain validated."""
    module = resolve_module_mapping(module)
    ref = module['ref_table']
    roles = ('topic', 'subtopic', 'indicator', 'filter')
    if not ref:
        return 'SELECT ' + ', '.join(f'NULL AS "{role}"' for role in roles) + ' WHERE FALSE'
    parts = ref.split('.')
    if len(parts) == 1:
        parts.insert(0, 'analytics')
    if len(parts) != 2 or parts[0] != 'analytics' or not all(re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', p) for p in parts):
        raise ValueError('Module ref_table must reference an analytics table')
    fields = []
    for role in roles:
        column = module[role]
        if not column:
            fields.append(f'NULL AS "{role}"')
            continue
        if column not in columns:
            raise ValueError(f'Invalid module column: {role}')
        escaped = column.replace('"', '""')
        fields.append(f'"{escaped}" AS "{role}"')
    return 'SELECT DISTINCT ' + ', '.join(fields) + f' FROM "analytics"."{parts[1]}"'


def pack_scores(rows, declared, lookup):
    names = dimension_names(declared)
    labels = {(str(r['dimension_name']), str(r['dimension_value'])): str(r['dimension_key']) for r in lookup}
    filters = {name: {} for name in names}
    result = []
    seen = set()
    for source in rows:
        dims = dimension_values(source.get('dim_cat_values'))
        # Legacy rows are supported only when no new breakdown has been supplied.
        if not dims and source.get('province_name'):
            dims = {'province': source['province_name']}
            if not names:
                names = ['province']
                filters.setdefault('province', {})
        series = json.dumps(dims, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
        observation = (series, source.get('year'))
        if observation in seen:
            raise ValueError('Duplicate score for dimension combination and year')
        seen.add(observation)
        parts = [labels.get((key, value), f'{key}: {value}') for key, value in sorted(dims.items())]
        if set(dims) == {'province'}:
            parts = [labels.get(('province', dims['province']), dims['province'])]
        for name in names:
            if name in dims:
                value = dims[name]
                filters[name][value] = labels.get((name, value), value)
        result.append({**source, 'dim_cat_values': dims, 'series_id': series,
                       'series_label': ' / '.join(parts) or 'کل کشور',
                       'province_name': (labels.get(('province', dims['province'])) or
                           (dims['province'] if not dims['province'].isdigit() else None)) if 'province' in dims else None})
    return result, [{'name': n, 'values': [{'value': v, 'label': label} for v, label in filters[n].items()]} for n in names]
