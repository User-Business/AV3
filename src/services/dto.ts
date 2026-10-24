import type {
  Contrato,
  Equipamento,
  JournalTransacao,
  Movimentacao,
  Usuario,
} from '../generated/prisma/client.js';
import { Contrato as ContratoDominio, isoDeDataSemHora } from '../domain/contrato.js';
import { Equipamento as EquipamentoDominio } from '../domain/equipamento.js';
import { Lote as LoteDominio } from '../domain/lote.js';
import type { OrganizacaoComContrato } from '../repositories/organizacao.repository.js';
import type { LoteComEquipamentos } from '../repositories/lote.repository.js';
import type { EquipamentoRastreado } from '../repositories/equipamento.repository.js';

/*
 * Conversão "linha do banco" -> "objeto de resposta". Mantém a API estável
 * mesmo se o schema mudar, e resolve tipos que o JSON não representa bem:
 * Decimal vira string (dinheiro) ou number (peso), DATE vira 'YYYY-MM-DD',
 * BigInt vira string.
 */

export function usuarioDTO(u: Usuario) {
  return {
    id: u.id,
    usuario: u.usuario,
    papel: u.papel,
    ativo: u.ativo,
    ultimoAcesso: u.ultimoAcesso?.toISOString() ?? null,
    versao: u.versao,
  };
}

export function contratoParaDominio(c: Contrato): ContratoDominio {
  return ContratoDominio.restaurar({
    dataAssinatura: isoDeDataSemHora(c.dataAssinatura),
    dataVencimento: isoDeDataSemHora(c.dataVencimento),
    clausulas: c.clausulas as string[],
    valorMensal: c.valorMensal.toFixed(2),
    renovacaoAutomatica: c.renovacaoAutomatica,
  });
}

export function contratoDTO(c: Contrato) {
  const dominio = contratoParaDominio(c);
  return {
    id: c.id,
    organizacaoId: c.organizacaoId,
    ...dominio.valores,
    vigente: dominio.estaVigente(),
    versao: c.versao,
  };
}

export function organizacaoDTO(o: OrganizacaoComContrato) {
  return {
    id: o.id,
    codigo: o.codigo,
    razaoSocial: o.razaoSocial,
    cnpj: o.cnpj,
    inscricaoEstadual: o.inscricaoEstadual,
    enderecoCompleto: o.enderecoCompleto,
    telefone: o.telefone,
    email: o.email,
    dataCadastro: o.dataCadastro.toISOString(),
    ativo: o.ativo,
    versao: o.versao,
    contrato: o.contrato ? contratoDTO(o.contrato) : null,
  };
}

export function equipamentoParaDominio(e: Equipamento): EquipamentoDominio {
  return EquipamentoDominio.restaurar({
    id: e.id,
    codigoBarrasInterno: e.codigoBarrasInterno,
    tipo: e.tipo,
    marca: e.marca,
    modelo: e.modelo,
    anoFabricacao: e.anoFabricacao,
    estadoFisico: e.estadoFisico,
    pesoQuilogramas: e.pesoQuilogramas.toNumber(),
    loteId: e.loteId,
    posicaoNoLote: e.posicaoNoLote,
    statusRastreamento: e.statusRastreamento,
    versao: e.versao,
  });
}

export function equipamentoDTO(e: Equipamento) {
  return {
    id: e.id,
    codigoBarrasInterno: e.codigoBarrasInterno,
    tipo: e.tipo,
    marca: e.marca,
    modelo: e.modelo,
    anoFabricacao: e.anoFabricacao,
    estadoFisico: e.estadoFisico,
    pesoQuilogramas: e.pesoQuilogramas.toNumber(),
    loteId: e.loteId,
    posicaoNoLote: e.posicaoNoLote,
    statusRastreamento: e.statusRastreamento,
    depreciacao: equipamentoParaDominio(e).calcularDepreciacao(),
    versao: e.versao,
  };
}

export function movimentacaoDTO(m: Movimentacao) {
  return {
    id: m.id,
    dataHora: m.dataHora.toISOString(),
    origem: m.origem,
    destino: m.destino,
    responsavel: m.responsavel,
    observacao: m.observacao,
  };
}

export function loteParaDominio(l: LoteComEquipamentos): LoteDominio {
  return LoteDominio.restaurar(
    { id: l.id, organizacaoId: l.organizacaoId, statusProcessamento: l.statusProcessamento, versao: l.versao },
    l.equipamentos.map((e) => ({ statusRastreamento: e.statusRastreamento, pesoQuilogramas: e.pesoQuilogramas.toNumber() })),
  );
}

export function loteDTO(l: LoteComEquipamentos) {
  return {
    id: l.id,
    organizacaoId: l.organizacaoId,
    organizacao: l.organizacao,
    dataEntrada: l.dataEntrada.toISOString(),
    notaFiscal: l.notaFiscal,
    transportadora: l.transportadora,
    statusProcessamento: l.statusProcessamento,
    observacoes: l.observacoes,
    pesoTotalQuilogramas: loteParaDominio(l).calcularPesoTotal(),
    quantidadeEquipamentos: l.equipamentos.length,
    versao: l.versao,
    equipamentos: l.equipamentos.map(equipamentoDTO),
  };
}

export function rastreioDTO(e: EquipamentoRastreado) {
  return {
    equipamento: equipamentoDTO(e),
    lote: {
      id: e.lote.id,
      notaFiscal: e.lote.notaFiscal,
      dataEntrada: e.lote.dataEntrada.toISOString(),
      statusProcessamento: e.lote.statusProcessamento,
    },
    organizacao: e.lote.organizacao,
    movimentacoes: e.movimentacoes.map(movimentacaoDTO),
  };
}

export function journalDTO(j: JournalTransacao) {
  return {
    id: j.id.toString(),
    timestamp: j.timestamp.toISOString(),
    operacao: j.operacao,
    entidade: j.entidade,
    entidadeId: j.entidadeId,
    dadosAntes: j.dadosAntes,
    dadosDepois: j.dadosDepois,
    usuarioResponsavel: j.usuarioResponsavel,
  };
}
