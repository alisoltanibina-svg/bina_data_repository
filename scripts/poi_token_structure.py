"""Offline structural analysis only. Never treats an opaque token as a stable ID."""
import base64
import hashlib
import re


def decode_token(value):
    if not isinstance(value,str) or len(value)>2048 or not re.fullmatch(r'[A-Za-z0-9_-]+={0,2}',value):
        raise ValueError('not_base64url')
    try:raw=base64.b64decode(value+'='*((-len(value))%4),altchars=b'-_',validate=True)
    except (ValueError,base64.binascii.Error):raise ValueError('not_base64url') from None
    if base64.urlsafe_b64encode(raw).decode().rstrip('=')!=value.rstrip('='):
        raise ValueError('noncanonical_base64url')
    return raw


def stable_runs(samples):
    result=[];start=None
    for offset in range(len(samples[0])+1):
        same=offset<len(samples[0]) and len({value[offset] for value in samples})==1
        if same and start is None:start=offset
        if not same and start is not None:result.append(dict(offset=start,length=offset-start));start=None
    return result


def analyze_tokens(live_tokens,historical_token,other_groups):
    """other_groups contains independently observed places, with repeated tokens.

    Labels identify comparison cohorts only, never production place matches.
    No keys, decoded bytes, raw tokens or cohort labels appear in the result.
    """
    result=dict(live_samples=len(live_tokens),distinct_live_tokens=len(set(live_tokens)),
        algorithm_identified=False,production_matching_enabled=False,experimental_regions=[])
    if len(live_tokens)<2:return {**result,'status':'insufficient_target_samples'}
    try:live=[decode_token(token) for token in live_tokens];historic=decode_token(historical_token)
    except ValueError:return {**result,'status':'unsupported_or_noncanonical_token_encoding'}
    lengths=sorted({len(value) for value in live})
    result.update(encoding='base64url',decoded_byte_lengths=lengths,historical_decoded_bytes=len(historic))
    if len(lengths)!=1 or lengths[0]!=len(historic):return {**result,'status':'decoded_lengths_differ'}
    size=lengths[0]
    if size>256:return {**result,'status':'token_too_large_for_block_analysis'}
    groups=[];invalid=0
    for tokens in other_groups:
        try:
            values=[decode_token(token) for token in tokens]
            if not values or any(len(value)!=size for value in values):invalid+=1;continue
            groups.append(values)
        except ValueError:invalid+=1
    result.update(status='analyzed',other_place_groups=len(groups),other_place_groups_with_repeats=sum(len(g)>=2 for g in groups),
        skipped_other_groups=invalid,changed_bytes_between_live_samples=[sum(a!=b for a,b in zip(live[i-1],live[i])) for i in range(1,len(live))],
        live_stable_byte_runs=stable_runs(live),live_and_historical_stable_byte_runs=stable_runs(live+[historic]))
    blocks=[]
    for offset in range(0,size,16):
        length=min(16,size-offset);part=live[0][offset:offset+length]
        blocks.append(dict(offset=offset,length=length,stable_in_live_samples=all(value[offset:offset+length]==part for value in live),
            matches_historical=historic[offset:offset+length]==part,
            other_places_sharing_block=sum(any(value[offset:offset+length]==part for value in group) for group in groups)))
    result['aligned_16_byte_blocks']=blocks
    regions={(b['offset'],b['length']) for b in blocks if b['length']==16}
    regions.update((run['offset'],run['length']) for run in result['live_and_historical_stable_byte_runs'] if run['length']>=16)
    # At least three independently observed places, repeated over time, are
    # required even to report an experimental region. This is not a stability guarantee.
    enough=result['other_place_groups_with_repeats']>=2
    for offset,length in sorted(regions):
        part=live[0][offset:offset+length]
        if not enough or any(value[offset:offset+length]!=part for value in live+[historic]):continue
        if any(any(value[offset:offset+length]!=group[0][offset:offset+length] for value in group) for group in groups):continue
        parts=[part]+[group[0][offset:offset+length] for group in groups]
        if len(set(parts))!=len(parts):continue
        result['experimental_regions'].append(dict(offset=offset,length=length,
            target_region_fingerprint=hashlib.sha256(part).hexdigest(),
            stable_for_all_observed_groups=True,matches_historical_target=True,
            observed_distinct_place_groups=len(groups)+1,observed_collisions=0))
    result['conclusion']='experimental_regions_require_provider_confirmation' if result['experimental_regions'] else 'no_validated_identity_region_found'
    return result
